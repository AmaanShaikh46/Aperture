import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.api.assist import (
    AssistCommandRequest,
    retry_assist_command,
    submit_assist_command,
)
from app.models.profiles import Profile


class FakeResult:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def scalars(self):
        return self

    def all(self):
        return list(self.rows)

    def scalar_one_or_none(self):
        return self.rows[0] if self.rows else None


class FakeSession:
    def __init__(self, results=()):
        self.results = list(results)
        self.added = []
        self.committed = False
        self.rolled_back = False

    async def execute(self, statement):
        if not self.results:
            raise AssertionError("Unexpected database query in unit test")
        return self.results.pop(0)

    def add(self, value):
        self.added.append(value)

    async def commit(self):
        self.committed = True

    async def refresh(self, value):
        pass

    async def rollback(self):
        self.rolled_back = True


@pytest.mark.asyncio
async def test_unsupported_command_is_not_persisted():
    owner_id = uuid.uuid4()
    db = FakeSession([FakeResult()])

    response = await submit_assist_command(
        data=AssistCommandRequest(transcript="delete all my messages"),
        current_user={"id": str(owner_id)},
        db=db,
    )

    assert response["state"] == "ERROR"
    assert response["commandId"] is None
    assert response["confirmationRequired"] is False
    assert "No action was taken" in response["spokenResponse"]
    assert db.added == []
    assert db.committed is False


@pytest.mark.asyncio
async def test_valid_message_is_saved_pending_confirmation():
    owner_id, friend_id = uuid.uuid4(), uuid.uuid4()
    low_id, high_id = sorted((owner_id, friend_id), key=lambda item: item.int)
    now = datetime.now(timezone.utc)

    friendship = SimpleNamespace(
        user_low_id=low_id,
        user_high_id=high_id,
    )
    friend = Profile(
        id=friend_id,
        username="friend",
        display_name="Friend",
        avatar_url=None,
        bio=None,
        created_at=now,
        updated_at=now,
    )
    db = FakeSession([
        FakeResult([friendship]),
        FakeResult([friend]),
    ])

    response = await submit_assist_command(
        data=AssistCommandRequest(
            transcript="chat message Friend Hello there"
        ),
        current_user={"id": str(owner_id)},
        db=db,
    )

    assert response["state"] == "CONFIRMING"
    assert response["confirmationRequired"] is True
    assert response["intent"] == "SEND_MESSAGE"
    assert response["recipient"]["id"] == str(friend_id)
    assert response["message"] == "Hello there"
    assert response["intentConfidence"] < 1.0
    assert response["recipientMatchScore"] == 1.0
    assert response["risk"] == "medium"
    assert response["confidenceMethod"].startswith("rule-based")
    assert len(db.added) == 1

    command = db.added[0]
    assert command.owner_id == owner_id
    assert command.recipient_id == friend_id
    assert command.state == "pending_confirmation"
    assert command.message_content == "Hello there"
    assert command.expires_at > now
    assert db.committed is True
    assert db.rolled_back is False


@pytest.mark.asyncio
async def test_retry_cancels_old_command_without_renewing_confirmation(monkeypatch):
    from app.api import assist as assist_api

    owner_id, friend_id = uuid.uuid4(), uuid.uuid4()
    now = datetime.now(timezone.utc)
    from datetime import timedelta
    original_expiry = now + timedelta(minutes=2)
    command = SimpleNamespace(
        id=uuid.uuid4(),
        owner_id=owner_id,
        recipient_id=friend_id,
        intent="SEND_MESSAGE",
        message_content="Hello there",
        state="pending_confirmation",
        expires_at=original_expiry,
        updated_at=now,
    )
    recipient = Profile(
        id=friend_id,
        username="friend",
        display_name="Friend",
        avatar_url=None,
        bio=None,
        created_at=now,
        updated_at=now,
    )
    db = FakeSession([FakeResult([recipient])])

    async def owned_command(_db, _command_id, _owner_id):
        return command

    monkeypatch.setattr(assist_api, "_get_owned_command", owned_command)

    response = await retry_assist_command(
        command_id=command.id,
        current_user={"id": str(owner_id)},
        db=db,
    )

    assert response["commandId"] == str(command.id)
    assert response["state"] == "CONFIRMING"
    assert response["spokenResponse"] == "Ready to listen again."
    assert command.state == "cancelled"
    assert command.expires_at == original_expiry
    assert db.committed is True
    assert db.rolled_back is False


@pytest.mark.asyncio
async def test_executing_call_recovery_reuses_existing_call(monkeypatch):
    from app.api import assist as assist_api

    owner_id, friend_id = uuid.uuid4(), uuid.uuid4()
    command_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    command = SimpleNamespace(
        id=command_id,
        owner_id=owner_id,
        recipient_id=friend_id,
        intent="CALL_CONTACT",
        message_content=None,
        state="executing",
        updated_at=now,
    )
    existing_call = SimpleNamespace(
        id=uuid.uuid4(),
        caller_id=owner_id,
        callee_id=friend_id,
        assist_command_id=command_id,
        call_type="audio",
        status="ringing",
        created_at=now,
        ended_at=None,
        ended_by=None,
    )
    caller = Profile(
        id=owner_id,
        username="caller",
        display_name="Caller",
        avatar_url=None,
        bio=None,
        created_at=now,
        updated_at=now,
    )
    recipient = Profile(
        id=friend_id,
        username="friend",
        display_name="Friend",
        avatar_url=None,
        bio=None,
        created_at=now,
        updated_at=now,
    )
    db = FakeSession([
        FakeResult([existing_call]),
        FakeResult([caller, recipient]),
        FakeResult([existing_call]),
    ])
    notifications = []

    async def owned_command(_db, _command_id, _owner_id):
        return command

    async def friends_still_accepted(_db, _owner_id, _friend_id):
        return None

    async def record_notification(user_id, event_type, payload):
        notifications.append((user_id, event_type, payload))

    monkeypatch.setattr(assist_api, "_get_owned_command", owned_command)
    monkeypatch.setattr(assist_api, "require_friends", friends_still_accepted)
    monkeypatch.setattr(assist_api, "_notify", record_notification)

    response = await assist_api.confirm_assist_command(
        command_id=command_id,
        current_user={"id": str(owner_id)},
        db=db,
    )

    assert response["state"] == "SUCCESS"
    assert response["callId"] == str(existing_call.id)
    assert existing_call.assist_command_id == command_id
    assert command.state == "succeeded"
    assert db.added == []
    assert db.committed is True
    assert len(notifications) == 1
    assert notifications[0][0] == friend_id
    assert notifications[0][1] == "call.incoming"
    assert notifications[0][2]["callId"] == str(existing_call.id)

@pytest.mark.asyncio
async def test_executing_call_recovery_cancels_call_when_friendship_revoked(monkeypatch):
    from fastapi import HTTPException
    from app.api import assist as assist_api

    owner_id, friend_id = uuid.uuid4(), uuid.uuid4()
    command_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    command = SimpleNamespace(
        id=command_id,
        owner_id=owner_id,
        recipient_id=friend_id,
        intent="CALL_CONTACT",
        message_content=None,
        state="executing",
        updated_at=now,
    )
    existing_call = SimpleNamespace(
        id=uuid.uuid4(),
        caller_id=owner_id,
        callee_id=friend_id,
        assist_command_id=command_id,
        call_type="audio",
        status="ringing",
        created_at=now,
        ended_at=None,
        ended_by=None,
    )
    db = FakeSession([
        FakeResult([existing_call]),
        FakeResult([existing_call]),
    ])
    notifications = []

    async def owned_command(_db, _command_id, _owner_id):
        return command

    async def revoked_friendship(_db, _owner_id, _friend_id):
        raise HTTPException(status_code=403, detail="Friendship required")

    async def record_notification(user_id, event_type, payload):
        notifications.append((user_id, event_type, payload))

    monkeypatch.setattr(assist_api, "_get_owned_command", owned_command)
    monkeypatch.setattr(assist_api, "require_friends", revoked_friendship)
    monkeypatch.setattr(assist_api, "_notify", record_notification)

    response = await assist_api.confirm_assist_command(
        command_id=command_id,
        current_user={"id": str(owner_id)},
        db=db,
    )

    assert response["state"] == "ERROR"
    assert command.state == "failed"
    assert existing_call.status == "cancelled"
    assert existing_call.ended_by == owner_id
    assert existing_call.ended_at is not None
    assert notifications == []
    assert db.rolled_back is True
    assert db.committed is True

@pytest.mark.asyncio
async def test_incoming_call_notification_failure_cancels_call_and_fails_command(
    monkeypatch,
):
    from app.api import assist as assist_api

    owner_id, friend_id = uuid.uuid4(), uuid.uuid4()
    command_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    command = SimpleNamespace(
        id=command_id,
        owner_id=owner_id,
        recipient_id=friend_id,
        intent="CALL_CONTACT",
        state="executing",
        updated_at=now,
    )
    call = SimpleNamespace(
        id=uuid.uuid4(),
        caller_id=owner_id,
        callee_id=friend_id,
        assist_command_id=command_id,
        call_type="audio",
        status="ringing",
        created_at=now,
        ended_at=None,
        ended_by=None,
    )
    caller = SimpleNamespace(
        id=owner_id,
        username="caller",
        display_name="Caller",
        avatar_url=None,
    )
    db = FakeSession([])
    notifications = []

    async def flaky_notify(user_id, event_type, payload):
        notifications.append((user_id, event_type, payload))
        if event_type == "call.incoming":
            raise RuntimeError("simulated WebSocket delivery failure")

    monkeypatch.setattr(assist_api, "_notify", flaky_notify)

    delivered = await assist_api._notify_incoming_call_or_cancel(
        db, command, call, owner_id, caller
    )

    assert delivered is False
    assert call.status == "cancelled"
    assert call.ended_by == owner_id
    assert call.ended_at is not None
    assert command.state == "failed"
    assert command.updated_at is not None
    assert db.committed is True

    assert notifications[0][1] == "call.incoming"
    ended_events = [
        item for item in notifications if item[1] == "call.ended"
    ]
    assert len(ended_events) == 2
    assert {item[0] for item in ended_events} == {owner_id, friend_id}
    assert all(item[2]["callId"] == str(call.id) for item in ended_events)

@pytest.mark.asyncio
async def test_executing_call_recovery_notification_failure_cancels_existing_call(
    monkeypatch,
):
    """Recover the same call, then cancel it if its incoming event raises."""
    from app.api import assist as assist_api

    owner_id, friend_id = uuid.uuid4(), uuid.uuid4()
    command_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    command = SimpleNamespace(
        id=command_id,
        owner_id=owner_id,
        recipient_id=friend_id,
        intent="CALL_CONTACT",
        message_content=None,
        state="executing",
        updated_at=now,
    )
    existing_call = SimpleNamespace(
        id=uuid.uuid4(),
        caller_id=owner_id,
        callee_id=friend_id,
        assist_command_id=command_id,
        call_type="audio",
        status="ringing",
        created_at=now,
        ended_at=None,
        ended_by=None,
    )
    caller = SimpleNamespace(
        id=owner_id,
        username="caller",
        display_name="Caller",
        avatar_url=None,
    )
    recipient = SimpleNamespace(
        id=friend_id,
        username="friend",
        display_name="Friend",
        avatar_url=None,
    )
    db = FakeSession([
        FakeResult([existing_call]),
        FakeResult([caller, recipient]),
        FakeResult([existing_call]),
    ])
    notifications = []

    async def owned_command(_db, _command_id, _owner_id):
        return command

    async def friends_still_accepted(_db, _owner_id, _friend_id):
        return None

    async def flaky_notify(user_id, event_type, payload):
        notifications.append((user_id, event_type, payload))
        if event_type == "call.incoming":
            raise RuntimeError("simulated incoming-event delivery failure")

    monkeypatch.setattr(assist_api, "_get_owned_command", owned_command)
    monkeypatch.setattr(assist_api, "require_friends", friends_still_accepted)
    monkeypatch.setattr(assist_api, "_notify", flaky_notify)

    response = await assist_api.confirm_assist_command(
        command_id=command_id,
        current_user={"id": str(owner_id)},
        db=db,
    )

    assert response["state"] == "ERROR"
    assert "cancelled the call" in response["spokenResponse"]
    assert command.state == "failed"
    assert existing_call.status == "cancelled"
    assert existing_call.ended_by == owner_id
    assert existing_call.ended_at is not None
    assert db.added == []
    assert db.committed is True

    assert [event[1] for event in notifications] == [
        "call.incoming", "call.ended", "call.ended"
    ]
    assert {event[0] for event in notifications[1:]} == {owner_id, friend_id}
    assert all(event[2]["callId"] == str(existing_call.id) for event in notifications)


@pytest.mark.asyncio
async def test_cleanup_notification_failures_do_not_undo_persisted_cancellation(
    monkeypatch,
):
    """Cleanup events are best-effort after the call and command are committed."""
    from app.api import assist as assist_api

    owner_id, friend_id = uuid.uuid4(), uuid.uuid4()
    command_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    command = SimpleNamespace(
        id=command_id,
        owner_id=owner_id,
        recipient_id=friend_id,
        state="executing",
        updated_at=now,
    )
    call = SimpleNamespace(
        id=uuid.uuid4(),
        caller_id=owner_id,
        callee_id=friend_id,
        assist_command_id=command_id,
        call_type="audio",
        status="ringing",
        created_at=now,
        ended_at=None,
        ended_by=None,
    )
    caller = SimpleNamespace(
        username="caller",
        display_name="Caller",
        avatar_url=None,
    )
    db = FakeSession([])
    attempts = []

    async def fail_every_notification(user_id, event_type, payload):
        attempts.append((user_id, event_type, payload))
        raise RuntimeError("simulated WebSocket failure for every event")

    monkeypatch.setattr(assist_api, "_notify", fail_every_notification)

    delivered = await assist_api._notify_incoming_call_or_cancel(
        db, command, call, owner_id, caller
    )

    assert delivered is False
    assert command.state == "failed"
    assert call.status == "cancelled"
    assert call.ended_by == owner_id
    assert call.ended_at is not None
    assert db.committed is True
    assert len(attempts) == 3
    assert [event[1] for event in attempts].count("call.incoming") == 1
    assert [event[1] for event in attempts].count("call.ended") == 2


@pytest.mark.asyncio
async def test_ambiguous_message_returns_recipient_choices_without_persisting():
    owner_id = uuid.uuid4()
    friends = [
        Profile(id=uuid.uuid4(), username="shiv", display_name="Shiv", avatar_url=None, bio=None, created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc)),
        Profile(id=uuid.uuid4(), username="shivratn", display_name="Shivratn", avatar_url=None, bio=None, created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc)),
    ]
    friendships = [SimpleNamespace(user_low_id=min(owner_id, friend.id, key=lambda value: value.int), user_high_id=max(owner_id, friend.id, key=lambda value: value.int)) for friend in friends]
    db = FakeSession([FakeResult(friendships), FakeResult(friends)])
    response = await submit_assist_command(
        data=AssistCommandRequest(transcript="chat message Shiv Ratna hello"),
        current_user={"id": str(owner_id)},
        db=db,
    )
    assert response["state"] == "ERROR"
    assert response["confirmationRequired"] is False
    assert len(response["clarificationOptions"]) == 2
    assert db.added == []
    assert db.committed is False
