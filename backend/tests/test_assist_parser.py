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

def test_name_matching_requests_confirmation_for_lower_confidence_asr_distortion():
    result = parse_assist_transcript("call shivratana", NAME_FRIENDS)
    assert result.command is None
    assert len(result.clarification_options) == 1
    assert result.clarification_options[0].username == "shivratn"

def test_fuzzy_name_matching_refuses_ambiguous_contacts():
    friends = NAME_FRIENDS + [SimpleNamespace(id="shiv-id-2", username="shivratna", display_name="shivratna")]
    result = parse_assist_transcript("call shivratana", friends)
    assert result.command is None
    assert "More than one friend" in result.clarification


def test_message_asr_variant_requires_recipient_choice_and_preserves_body():
    result = parse_assist_transcript("chat message shivratana hello there", NAME_FRIENDS)
    assert result.command is None
    assert len(result.clarification_options) == 1
    assert result.clarification_options[0].username == "shivratn"
    assert result.clarification_options[0].transcript == "chat message shivratn hello there"


def test_message_does_not_silently_choose_short_contact_over_similar_long_username():
    friends = [
        SimpleNamespace(id="shiv-id", username="shiv", display_name="Shiv"),
        SimpleNamespace(id="shivratn-id", username="shivratn", display_name="Shivratn"),
    ]
    result = parse_assist_transcript("chat message Shiv Ratna hello", friends)
    assert result.command is None
    assert "Choose the intended username" in result.clarification
    assert {option.username for option in result.clarification_options} == {"shiv", "shivratn"}
    assert {option.transcript for option in result.clarification_options} == {
        "chat message shiv Ratna hello",
        "chat message shivratn hello",
    }


def test_asr_name_variant_requires_choice_even_without_competing_contact():
    friends = [SimpleNamespace(id="shivratn-id", username="shivratn", display_name="Shivratn")]
    result = parse_assist_transcript("chat message shivratana hello", friends)
    assert result.command is None
    assert len(result.clarification_options) == 1
    assert result.clarification_options[0].username == "shivratn"
    assert result.clarification_options[0].transcript == "chat message shivratn hello"


def test_username_with_inserted_spaces_matches_exactly():
    friends = [SimpleNamespace(id="ishwar-id", username="ishwarsingh", display_name="Ishwar Singh")]
    result = parse_assist_transcript("call ishwar singh", friends)
    assert result.command is not None
    assert result.command.recipient_id == "ishwar-id"
    assert result.command.recipient_match_score == 1.0


def test_low_confidence_single_recipient_requires_explicit_choice():
    friends = [SimpleNamespace(id="shivratn-id", username="shivratn", display_name="Shivratn")]
    result = parse_assist_transcript("call shivratana", friends)
    assert result.command is None
    assert "no call was placed" in result.clarification.lower()
    assert len(result.clarification_options) == 1
    assert result.clarification_options[0].username == "shivratn"


def test_three_character_prefix_is_generic_and_requires_choice():
    friends = [SimpleNamespace(id="contact-1", username="alexander", display_name="Alex")]
    result = parse_assist_transcript("call ale", friends)
    assert result.command is None
    assert len(result.clarification_options) == 1
    assert result.clarification_options[0].username == "alexander"


def test_shorter_prefix_does_not_match():
    friends = [SimpleNamespace(id="contact-1", username="alexander", display_name="Alexander")]
    result = parse_assist_transcript("call al", friends)
    assert result.command is None
    assert not result.clarification_options


def test_prefix_matching_asks_when_multiple_contacts_share_prefix():
    friends = [
        SimpleNamespace(id="contact-1", username="alexander", display_name="Alexander"),
        SimpleNamespace(id="contact-2", username="alexandra", display_name="Alexandra"),
    ]
    result = parse_assist_transcript("call alex", friends)
    assert result.command is None
    assert len(result.clarification_options) == 2


def test_video_call_intent_preserves_video_type():
    result = parse_assist_transcript("video call Sam", FRIENDS)
    assert result.command is not None
    assert result.command.intent == "CALL_CONTACT"
    assert result.command.call_type == "video"
    assert result.command.recipient_id == "friend-1"

def test_audio_call_intent_preserves_audio_type():
    result = parse_assist_transcript("audio call Sam", FRIENDS)
    assert result.command is not None
    assert result.command.call_type == "audio"


def test_legacy_call_defaults_to_audio():
    result = parse_assist_transcript("call Sam", FRIENDS)
    assert result.command is not None
    assert result.command.call_type == "audio"


def test_video_call_clarification_preserves_requested_call_type():
    result = parse_assist_transcript("video call shivratana", NAME_FRIENDS)
    assert result.command is None
    assert len(result.clarification_options) == 1
    assert result.clarification_options[0].transcript.startswith("video call ")
