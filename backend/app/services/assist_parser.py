import re
from dataclasses import dataclass, field
from typing import Iterable


@dataclass(frozen=True)
class ParsedAssistCommand:
    intent: str
    recipient_id: object
    recipient_name: str
    message: str | None = None
    intent_confidence: float = 0.99
    recipient_match_score: float = 1.0


@dataclass(frozen=True)
class ClarificationOption:
    recipient_id: object
    username: str
    display_name: str
    transcript: str


@dataclass(frozen=True)
class ParseResult:
    command: ParsedAssistCommand | None
    clarification: str | None
    clarification_options: list[ClarificationOption] = field(default_factory=list)


def _normalise(value: str) -> str:
    return " ".join(value.casefold().split())


def _compact(value: str) -> str:
    return "".join(ch for ch in value.casefold() if ch.isalnum())


def _edit_distance(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def _name_distance(requested: str, candidate: str) -> int | None:
    requested_compact, candidate_compact = _compact(requested), _compact(candidate)
    if not requested_compact or not candidate_compact:
        return None
    if requested_compact == candidate_compact:
        return 0
    # A spoken prefix may be a truncated ASR result for a saved username or
    # display name. Allow meaningful prefixes from 3 characters onward; the
    # caller will require an explicit recipient choice rather than auto-send.
    if len(requested_compact) >= 3 and candidate_compact.startswith(requested_compact):
        return len(candidate_compact) - len(requested_compact)

    # Conservative ASR tolerance: one edit for short names, at most three for long names.
    limit = min(3, max(1, len(candidate_compact) // 4))
    distance = _edit_distance(requested_compact, candidate_compact)
    return distance if distance <= limit else None


def _friends(friends: Iterable[object]) -> list[dict]:
    output = []
    seen = set()
    for friend in friends:
        friend_id = getattr(friend, "id", None)
        username = getattr(friend, "username", None)
        display = getattr(friend, "display_name", None) or username
        if friend_id is None or not isinstance(display, str) or not display.strip():
            continue
        key = str(friend_id)
        if key in seen:
            continue
        seen.add(key)
        aliases = []
        # Prefer usernames on exact ties: usernames are stable, unique identifiers.
        if isinstance(username, str) and username.strip():
            aliases.append((username.strip(), 0))
        if isinstance(display, str) and display.strip() and _normalise(display) != _normalise(username or ""):
            aliases.append((display.strip(), 1))
        output.append({"id": friend_id, "username": username.strip() if isinstance(username, str) else "", "display": display.strip(), "aliases": aliases})
    return output


def _match_score(distance: int, alias: str) -> float:
    # A transparent similarity heuristic, deliberately NOT a probability.
    return round(max(0.0, 1.0 - distance / max(1, len(_compact(alias)))), 3)


def _options(items: list[dict], intent: str, body_by_id: dict[str, str] | None = None) -> list[ClarificationOption]:
    options = []
    for item in items:
        username = item["username"] or item["display"]
        if intent == "CALL_CONTACT":
            transcript = f"call {username}"
        else:
            body = (body_by_id or {}).get(str(item["id"]), "")
            transcript = f"chat message {username} {body}".strip()
        options.append(ClarificationOption(item["id"], username, item["display"], transcript))
    return options


def parse_assist_transcript(transcript: str, friends: Iterable[object]) -> ParseResult:
    if not isinstance(transcript, str):
        return ParseResult(None, "I couldn't understand that request. No action was taken.")
    transcript = transcript.strip()
    if not transcript or len(transcript) > 12000 or "\x00" in transcript:
        return ParseResult(None, "Please provide a valid request. No action was taken.")

    message_match = re.fullmatch(r"chat\s+message\s+(.+)", transcript, flags=re.IGNORECASE | re.DOTALL)
    call_match = re.fullmatch(r"call\s+(.+)", transcript, flags=re.IGNORECASE | re.DOTALL)
    if message_match:
        intent, remainder = "SEND_MESSAGE", message_match.group(1).strip()
    elif call_match:
        intent, remainder = "CALL_CONTACT", call_match.group(1).strip()
    else:
        return ParseResult(None, "I can help with 'call [friend's name]' or 'chat message [friend's name] [message]'. No action was taken.")

    candidates = _friends(friends)
    if intent == "CALL_CONTACT":
        ranked = []
        for item in candidates:
            for alias, alias_priority in item["aliases"]:
                distance = _name_distance(remainder, alias)
                if distance is not None:
                    ranked.append((distance, alias_priority, item, alias))
        if not ranked:
            return ParseResult(None, "I couldn't identify a friend by that name. No call was placed.")
        ranked.sort(key=lambda row: (row[0], row[1]))
        best_distance = ranked[0][0]
        best_by_id = {}
        for distance, priority, item, alias in ranked:
            if distance <= best_distance + 1:
                previous = best_by_id.get(str(item["id"]))
                if previous is None or (distance, priority) < previous[:2]:
                    best_by_id[str(item["id"])] = (distance, priority, item, alias)
        if len(best_by_id) != 1:
            choices = [row[2] for row in sorted(best_by_id.values(), key=lambda row: (row[0], row[1]))]
            return ParseResult(None, "More than one friend matches that name. Choose the intended username below; no call was placed.", _options(choices, intent))
        distance, _, item, alias = next(iter(best_by_id.values()))
        score = _match_score(distance, alias)
        if score < 0.85:
            return ParseResult(None, f"I may have heard {item['display']} ({item['username']}). Please confirm the contact; no call was placed.", _options([item], intent))
        return ParseResult(ParsedAssistCommand(intent, item["id"], item["display"], intent_confidence=0.99, recipient_match_score=score), None)

    tokens = remainder.split()
    ranked = []
    # Evaluate every plausible leading span, not just the first exact-looking token.
    # This detects the dangerous case where "Shiv Ratna hello" could mean either
    # recipient Shiv + body "Ratna hello" or recipient Shivratn + body "hello".
    for item in candidates:
        best_for_friend = None
        for alias, alias_priority in item["aliases"]:
            max_count = min(max(1, len(tokens) - 1), max(3, len(alias.split()) + 1))
            for count in range(1, max_count + 1):
                spoken_name = " ".join(tokens[:count])
                distance = _name_distance(spoken_name, alias)
                body = " ".join(tokens[count:]).strip()
                if distance is None or not body:
                    continue
                candidate = (distance, alias_priority, -count, item, alias, body)
                if best_for_friend is None or candidate[:3] < best_for_friend[:3]:
                    best_for_friend = candidate
        if best_for_friend:
            ranked.append(best_for_friend)

    if not ranked:
        return ParseResult(None, "I couldn't safely separate the recipient from the message. Say 'chat message [username] [message]'. No message was sent.")
    ranked.sort(key=lambda row: (row[0], row[1], row[2]))
    best_distance = ranked[0][0]
    # Exact longer names beat exact shorter prefixes ("Sam Lee" beats "Sam").
    exact = [row for row in ranked if row[0] == best_distance]
    exact_by_id = {}
    for row in exact:
        key = str(row[3]["id"])
        if key not in exact_by_id or row[:3] < exact_by_id[key][:3]:
            exact_by_id[key] = row
    if len(exact_by_id) > 1:
        longest_count = min(row[2] for row in exact_by_id.values())
        longest = [row for row in exact_by_id.values() if row[2] == longest_count]
        if len(longest) == 1:
            best = longest[0]
        else:
            options_rows = longest
            body_by_id = {str(row[3]["id"]): row[5] for row in options_rows}
            return ParseResult(None, "These contacts sound similar. Choose the intended username; no message was sent.", _options([row[3] for row in options_rows], intent, body_by_id))
    else:
        best = next(iter(exact_by_id.values()))

    # A shorter exact contact and a longer near-match are ambiguous: e.g. "Shiv
    # Ratna hello" may mean Shiv + body "Ratna hello" or Shivratn + "hello".
    best_count = -best[2]
    near_longer = [row for row in ranked if str(row[3]["id"]) != str(best[3]["id"])
                   and row[0] == best[0] + 1 and -row[2] > best_count]
    if near_longer:
        options_rows = [best]
        for row in near_longer:
            if all(str(existing[3]["id"]) != str(row[3]["id"]) for existing in options_rows):
                options_rows.append(row)
        body_by_id = {str(row[3]["id"]): row[5] for row in options_rows}
        return ParseResult(None, "These contacts sound similar. Choose the intended username; no message was sent.", _options([row[3] for row in options_rows], intent, body_by_id))

    distance, _, _, item, alias, body = best
    if not body or len(body) > 10000 or "\x00" in body:
        return ParseResult(None, "Please provide a valid message. Nothing was sent.")
    score = _match_score(distance, alias)
    if score < 0.85:
        option = _options([item], intent, {str(item["id"]): body})
        return ParseResult(None, f"I may have heard {item['display']} ({item['username']}). Confirm the recipient before sending; no message was sent.", option)
    return ParseResult(ParsedAssistCommand(intent, item["id"], item["display"], body, 0.99, score), None)
