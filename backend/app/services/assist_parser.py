import re
from dataclasses import dataclass
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
class ParseResult:
    command: ParsedAssistCommand | None
    clarification: str | None


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
    # Only tolerate small speech-recognition distortions on reasonably long names.
    limit = min(3, max(1, len(candidate_compact) // 4))
    distance = _edit_distance(requested_compact, candidate_compact)
    return distance if distance <= limit else None


def parse_assist_transcript(
    transcript: str,
    friends: Iterable[object],
) -> ParseResult:
    if not isinstance(transcript, str):
        return ParseResult(None, "I couldn't understand that request. No action was taken.")

    transcript = transcript.strip()
    if not transcript or len(transcript) > 12000 or "\x00" in transcript:
        return ParseResult(None, "Please provide a valid request. No action was taken.")

    # Check the explicit message prefix before any call-like interpretation.
    message_match = re.fullmatch(r"chat\s+message\s+(.+)", transcript, flags=re.IGNORECASE | re.DOTALL)
    call_match = re.fullmatch(r"call\s+(.+)", transcript, flags=re.IGNORECASE | re.DOTALL)
    if message_match:
        intent, remainder = "SEND_MESSAGE", message_match.group(1).strip()
    elif call_match:
        intent, remainder = "CALL_CONTACT", call_match.group(1).strip()
    else:
        return ParseResult(None, "I can help with 'call [friend's name]' or 'chat message [friend's name] [message]'. No action was taken.")

    candidates = []
    for friend in friends:
        friend_id = getattr(friend, "id", None)
        username = getattr(friend, "username", None)
        display_name = getattr(friend, "display_name", None) or username
        if friend_id is None or not isinstance(display_name, str):
            continue
        names = {_normalise(name) for name in (display_name, username) if isinstance(name, str) and name.strip()}
        if names:
            candidates.append((friend_id, display_name.strip(), names))

    # Calls match the complete spoken name. Near matches are accepted only if
    # one distinct friend is clearly best; ambiguous matches never place a call.
    if intent == "CALL_CONTACT":
        ranked = []
        for friend_id, display_name, names in candidates:
            distances = [_name_distance(remainder, name) for name in names]
            distances = [distance for distance in distances if distance is not None]
            if distances:
                ranked.append((min(distances), str(friend_id), friend_id, display_name))
        if not ranked:
            return ParseResult(None, "I couldn't identify exactly one friend by that name. No call was placed.")
        ranked.sort(key=lambda item: item[0])
        best_distance = ranked[0][0]
        best = {item[1]: item for item in ranked if item[0] == best_distance}
        if len(best) != 1 or (len(ranked) > 1 and ranked[1][0] - best_distance < 2):
            return ParseResult(None, "More than one friend matches that name. Please specify the full name. No call was placed.")
        _, _, friend_id, display_name = next(iter(best.values()))
        chosen_distance = best_distance
        matched_name_length = max(1, len(_compact(remainder)))
        recipient_score = max(0.0, min(1.0, 1.0 - chosen_distance / matched_name_length))
        return ParseResult(ParsedAssistCommand(
            "CALL_CONTACT", friend_id, display_name,
            intent_confidence=0.99, recipient_match_score=recipient_score,
        ), None)

    # For messages, try each leading token sequence as the recipient. This
    # handles inserted spaces and small ASR errors while preserving the body.
    tokens = remainder.split()
    ranked = []
    for friend_id, display_name, names in candidates:
        best_for_friend = None
        for name in names:
            max_tokens = min(len(tokens) - 1, max(1, len(name.split()) + 1))
            for count in range(1, max_tokens + 1):
                spoken_name = " ".join(tokens[:count])
                distance = _name_distance(spoken_name, name)
                if distance is not None:
                    body = " ".join(tokens[count:]).strip()
                    if body:
                        candidate = (distance, -count, str(friend_id), friend_id, display_name, body)
                        if best_for_friend is None or candidate[:2] < best_for_friend[:2]:
                            best_for_friend = candidate
        if best_for_friend:
            ranked.append(best_for_friend)

    if not ranked:
        return ParseResult(None, "I couldn't identify a recipient and message. Say 'chat message [friend's full name] [message]'. No message was sent.")
    ranked.sort(key=lambda item: (item[0], item[1]))
    best_score = ranked[0][:2]
    best = [item for item in ranked if item[:2] == best_score]
    distinct = {item[2] for item in best}
    if len(distinct) != 1 or (len(ranked) > 1 and ranked[1][2] != ranked[0][2] and (ranked[1][0] - ranked[0][0] < 2) and ranked[1][1] == ranked[0][1]):
        return ParseResult(None, "More than one friend matches that name. Please specify the full name. No message was sent.")
    distance, _, _, friend_id, display_name, body = best[0]
    if not body or len(body) > 10000 or "\x00" in body:
        return ParseResult(None, "Please provide a valid message. Nothing was sent.")
    matched_name_length = max(1, len(_compact(" ".join(tokens[:max(1, len(tokens) - len(body.split()))]))))
    recipient_score = max(0.0, min(1.0, 1.0 - distance / matched_name_length))
    return ParseResult(ParsedAssistCommand(
        "SEND_MESSAGE", friend_id, display_name, body,
        intent_confidence=0.99, recipient_match_score=recipient_score,
    ), None)
