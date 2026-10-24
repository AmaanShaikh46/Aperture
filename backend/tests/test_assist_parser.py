from types import SimpleNamespace

from app.services.assist_parser import parse_assist_transcript


FRIENDS = [
    SimpleNamespace(id="friend-1", username="sam", display_name="Sam"),
    SimpleNamespace(id="friend-2", username="sam lee", display_name="Sam Lee"),
]


def test_call_requires_exact_friend_name():
    result = parse_assist_transcript("call Sam", FRIENDS)
    assert result.command is not None
    assert result.command.intent == "CALL_CONTACT"
    assert result.command.recipient_id == "friend-1"


def test_call_rejects_unknown_friend():
    result = parse_assist_transcript("call Alex", FRIENDS)
    assert result.command is None
    assert "No call was placed" in result.clarification


def test_message_uses_longest_matching_name():
    result = parse_assist_transcript(
        "chat message Sam Lee Please call me back",
        FRIENDS,
    )
    assert result.command is not None
    assert result.command.recipient_id == "friend-2"
    assert result.command.message == "Please call me back"


def test_message_rejects_missing_body():
    result = parse_assist_transcript("chat message Sam", FRIENDS)
    assert result.command is None


def test_unsupported_command_does_not_create_action():
    result = parse_assist_transcript("read messages", FRIENDS)
    assert result.command is None
    assert "No action was taken" in result.clarification


def test_invalid_transcript_is_rejected():
    result = parse_assist_transcript("  ", FRIENDS)
    assert result.command is None


NAME_FRIENDS = [
    SimpleNamespace(id="ishwar-id", username="ishwarsingh", display_name="ishwarsingh"),
    SimpleNamespace(id="shiv-id", username="shivratn", display_name="shivratn"),
]

def test_message_intent_is_not_confused_with_call_intent():
    friends = FRIENDS + [SimpleNamespace(id="shiv-id", username="shiv", display_name="Shiv")]
    result = parse_assist_transcript("chat message Shiv hello", friends)
    assert result.command is not None
    assert result.command.intent == "SEND_MESSAGE"
    assert result.command.recipient_id == "shiv-id"
    assert result.command.message == "hello"

def test_name_matching_ignores_inserted_spaces():
    result = parse_assist_transcript("call ishwar singh", NAME_FRIENDS)
    assert result.command is not None
    assert result.command.recipient_id == "ishwar-id"

def test_name_matching_tolerates_small_asr_distortion():
    result = parse_assist_transcript("call shivratana", NAME_FRIENDS)
    assert result.command is not None
    assert result.command.recipient_id == "shiv-id"

def test_fuzzy_name_matching_refuses_ambiguous_contacts():
    friends = NAME_FRIENDS + [SimpleNamespace(id="shiv-id-2", username="shivratna", display_name="shivratna")]
    result = parse_assist_transcript("call shivratana", friends)
    assert result.command is None
    assert "More than one friend" in result.clarification


def test_message_matches_asr_variant_and_preserves_body():
    result = parse_assist_transcript("chat message shivratana hello there", NAME_FRIENDS)
    assert result.command is not None
    assert result.command.intent == "SEND_MESSAGE"
    assert result.command.recipient_id == "shiv-id"
    assert result.command.message == "hello there"


def test_exact_name_has_higher_match_score_than_asr_variant():
    exact = parse_assist_transcript("call ishwarsingh", NAME_FRIENDS)
    asr = parse_assist_transcript("call ishwar singh", NAME_FRIENDS)
    assert exact.command is not None and asr.command is not None
    assert exact.command.recipient_id == asr.command.recipient_id == "ishwar-id"
    assert exact.command.recipient_match_score >= asr.command.recipient_match_score
    assert 0.0 <= asr.command.recipient_match_score <= 1.0

def test_message_confidence_scores_are_present_and_bounded():
    friends = FRIENDS + [SimpleNamespace(id="shiv-id", username="shiv", display_name="Shiv")]
    result = parse_assist_transcript("chat message Shiv hello", friends)
    assert result.command is not None
    assert result.command.intent_confidence == 0.99
    assert 0.0 <= result.command.recipient_match_score <= 1.0
