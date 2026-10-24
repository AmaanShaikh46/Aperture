from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.conversations import Conversation
from app.models.call_session import CallSession
from app.models.friendship import Friendship
from app.services import message_service
from app.services.friendship_service import (
    are_friends,
    canonical_pair,
    get_relationship_state,
    require_direct_conversation_friendship,
    require_friends,
)


class FakeResult:
    def __init__(self, scalar=None, rows=None):
        self.scalar = scalar
        self.rows = rows

    def scalar_one_or_none(self):
        return self.scalar

    def scalars(self):
        return self

    def all(self):
        return list(self.rows or [])


class FakeSession:
    def __init__(self, results=()):
        self.results = list(results)
        self.statements = []
        self.added = []
        self.deleted = []
        self.committed = False
        self.commit_count = 0
        self.rolled_back = False

    async def execute(self, statement):
        self.statements.append(statement)
        if not self.results:
            raise AssertionError("Unexpected database query in unit test")
        result = self.results.pop(0)
        return result(self) if callable(result) else result

    def add(self, value):
        self.added.append(value)

    def add_all(self, values):
        self.added.extend(values)

    async def delete(self, value):
        self.deleted.append(value)

    async def flush(self):
        pass

    async def commit(self):
        self.committed = True
        self.commit_count += 1

    async def rollback(self):
        self.rolled_back = True

    async def refresh(self, value):
        pass


def test_canonical_pair_is_order_independent_and_rejects_self():
    first, second = uuid.uuid4(), uuid.uuid4()
    low, high = canonical_pair(first, second)
    assert low.int < high.int
    assert canonical_pair(second, first) == (low, high)
    with pytest.raises(ValueError):
        canonical_pair(first, first)


@pytest.mark.asyncio
async def test_are_friends_uses_canonical_pair():
    first, second = uuid.uuid4(), uuid.uuid4()
    db = FakeSession([FakeResult(scalar=uuid.uuid4())])
    assert await are_friends(db, first, second) is True
    assert len(db.statements) == 1


@pytest.mark.asyncio
async def test_relationship_state_reports_incoming_pending_request():
    first, second = uuid.uuid4(), uuid.uuid4()
    request_id = uuid.uuid4()
    request = SimpleNamespace(id=request_id, status="pending", sender_id=second)
    db = FakeSession([FakeResult(), FakeResult(scalar=request)])
    state = await get_relationship_state(db, first, second)
    assert state == {"relationshipStatus": "request_received", "friendRequestId": str(request_id)}


@pytest.mark.asyncio
async def test_require_friends_rejects_nonfriends():
    db = FakeSession([FakeResult()])
    with pytest.raises(HTTPException) as exc:
        await require_friends(db, uuid.uuid4(), uuid.uuid4())
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_direct_conversation_requires_friendship():
    user_id, friend_id, conversation_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    conversation = Conversation(id=conversation_id, type="direct")
    db = FakeSession([
        FakeResult(scalar=conversation),
        FakeResult(rows=[friend_id]),
        FakeResult(),
    ])
    with pytest.raises(HTTPException) as exc:
        await require_direct_conversation_friendship(db, conversation_id, user_id)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_group_conversation_does_not_require_friendship():
    conversation_id = uuid.uuid4()
    conversation = Conversation(id=conversation_id, type="group")
    db = FakeSession([FakeResult(scalar=conversation)])
    await require_direct_conversation_friendship(db, conversation_id, uuid.uuid4())
    assert len(db.statements) == 1


@pytest.mark.asyncio
async def test_message_is_not_added_when_friendship_check_fails(monkeypatch):
    user_id, conversation_id = uuid.uuid4(), uuid.uuid4()
    conversation = Conversation(id=conversation_id, type="direct")
    db = FakeSession([
        FakeResult(scalar=object()),  # Sender is a conversation participant.
        FakeResult(scalar=conversation),
    ])

    async def deny(*args, **kwargs):
        raise HTTPException(status_code=403, detail="friends only")

    monkeypatch.setattr(message_service, "require_direct_conversation_friendship", deny)
    with pytest.raises(HTTPException) as exc:
        await message_service.create_message(db, conversation_id, user_id, "Hello")
    assert exc.value.status_code == 403
    assert db.added == []
    assert db.committed is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("initial_status", "expected_status"),
    [("accepted", "completed"), ("ringing", "cancelled")],
)
async def test_removing_friend_ends_related_active_calls(
    monkeypatch, initial_status, expected_status
):
    from app.api.v1.users import friendships as friendship_routes

    user_id, friend_id = uuid.uuid4(), uuid.uuid4()
    low, high = canonical_pair(user_id, friend_id)
    friendship = Friendship(user_low_id=low, user_high_id=high)
    call = CallSession(
        id=uuid.uuid4(),
        caller_id=user_id,
        callee_id=friend_id,
        status=initial_status,
    )
    db = FakeSession([FakeResult(scalar=friendship), FakeResult(rows=[call])])
    sent_events = []

    async def fake_send_to_user(target_user_id, event):
        sent_events.append((target_user_id, event))

    monkeypatch.setattr(friendship_routes.manager, "send_to_user", fake_send_to_user)
    result = await friendship_routes.remove_friend(
        friend_id=friend_id,
        current_user={"id": str(user_id)},
        db=db,
    )

    assert result["success"] is True
    assert result["removed"] is True
    assert result["endedCalls"] == 1
    assert call.status == expected_status
    assert call.ended_by == user_id
    assert db.committed is True
    assert db.deleted == [friendship]
    assert {target for target, _event in sent_events} == {str(user_id), str(friend_id)}
    assert all(event["type"] == "call.ended" for _target, event in sent_events)


def test_migration_moves_messages_before_deleting_duplicate_conversations():
    from pathlib import Path

    migration_path = (
        Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "f13c8b2d94a1_add_friendships_and_requests.py"
    )
    source = migration_path.read_text(encoding="utf-8")
    move_messages_at = source.index("UPDATE messages AS m")
    delete_duplicates_at = source.index("DELETE FROM conversations AS c\n        USING _aperture_direct_merges")
    malformed_guard_at = source.index("direct conversation with message history does not have exactly two participants")
    unique_constraint_at = source.index('"uq_conversations_direct_pair"')
    assert move_messages_at < delete_duplicates_at < malformed_guard_at < unique_constraint_at
    assert '"ix_conversation_participants_user_id"' in source
    assert '"ix_messages_conversation_created_at"' in source


@pytest.mark.asyncio
async def test_accept_call_locks_friendship_before_call(monkeypatch):
    from app.api import calls as call_routes

    caller_id, callee_id, call_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    call = SimpleNamespace(
        id=call_id,
        caller_id=caller_id,
        callee_id=callee_id,
        status="ringing",
        call_type="audio",
        created_at=datetime.now(timezone.utc),
        accepted_at=None,
        ended_at=None,
        ended_by=None,
    )
    events = []

    async def fake_get_call(db, requested_call_id, user_id, *, lock=False):
        events.append("call_locked" if lock else "call_read")
        return call

    async def fake_require_friends(db, user_a, user_b):
        events.append("friendship_locked")

    async def fake_profile(db, user_id):
        return SimpleNamespace(display_name="Recipient", username="recipient", avatar_url=None)

    async def fake_notify(*args, **kwargs):
        pass

    monkeypatch.setattr(call_routes, "_get_call_for_user", fake_get_call)
    monkeypatch.setattr(call_routes, "require_friends", fake_require_friends)
    monkeypatch.setattr(call_routes, "_profile", fake_profile)
    monkeypatch.setattr(call_routes, "_notify", fake_notify)

    result = await call_routes.accept_call(
        call_id=call_id,
        current_user={"id": str(callee_id)},
        db=FakeSession(),
    )

    assert result == {"success": True, "callId": str(call_id), "status": "accepted"}
    assert events == ["call_read", "friendship_locked", "call_locked"]


class CallCreationSession(FakeSession):
    def add(self, value):
        super().add(value)
        if isinstance(value, CallSession):
            value.id = uuid.uuid4()
            value.created_at = datetime.now(timezone.utc)


@pytest.mark.asyncio
async def test_create_call_does_not_notify_if_friendship_disappears_before_delivery(monkeypatch):
    from app.api import calls as call_routes

    caller_id, callee_id = uuid.uuid4(), uuid.uuid4()
    caller = SimpleNamespace(id=caller_id, username="caller", display_name="Caller", avatar_url=None)
    callee = SimpleNamespace(id=callee_id, username="callee", display_name="Callee", avatar_url=None)
    lock_results = [
        FakeResult(scalar=participant_id)
        for participant_id in sorted((caller_id, callee_id), key=lambda value: value.int)
    ]
    db = CallCreationSession([
        *lock_results,
        FakeResult(),  # No existing call: initial active-call lookup.
        lambda session: FakeResult(scalar=session.added[0]),  # Lock the just-created call.
    ])
    relationship_checks = 0
    notifications = []

    async def fake_profile(_db, user_id):
        return caller if user_id == caller_id else callee

    async def fake_require_friends(_db, _first, _second):
        nonlocal relationship_checks
        relationship_checks += 1
        if relationship_checks == 2:
            raise HTTPException(status_code=403, detail="Friendship removed")

    async def fake_notify(*args, **kwargs):
        notifications.append((args, kwargs))

    monkeypatch.setattr(call_routes, "_profile", fake_profile)
    monkeypatch.setattr(call_routes, "require_friends", fake_require_friends)
    monkeypatch.setattr(call_routes, "_notify", fake_notify)

    with pytest.raises(HTTPException) as exc:
        await call_routes.create_call(
            data={"userId": str(callee_id), "callType": "audio"},
            current_user={"id": str(caller_id)},
            db=db,
        )

    assert exc.value.status_code == 409
    assert notifications == []
    call = next(item for item in db.added if isinstance(item, CallSession))
    assert call.status == "cancelled"
    assert call.ended_by == caller_id
    assert db.commit_count == 2


@pytest.mark.asyncio
async def test_create_call_notifies_only_after_rechecking_friendship(monkeypatch):
    from app.api import calls as call_routes

    caller_id, callee_id = uuid.uuid4(), uuid.uuid4()
    caller = SimpleNamespace(id=caller_id, username="caller", display_name="Caller", avatar_url=None)
    callee = SimpleNamespace(id=callee_id, username="callee", display_name="Callee", avatar_url=None)
    lock_results = [
        FakeResult(scalar=participant_id)
        for participant_id in sorted((caller_id, callee_id), key=lambda value: value.int)
    ]
    db = CallCreationSession([
        *lock_results,
        FakeResult(),  # No existing call: initial active-call lookup.
        lambda session: FakeResult(scalar=session.added[0]),  # Lock the just-created call.
    ])
    relationship_checks = []
    notification_commit_counts = []

    async def fake_profile(_db, user_id):
        return caller if user_id == caller_id else callee

    async def fake_require_friends(_db, first, second):
        relationship_checks.append((first, second))

    async def fake_notify(*_args, **_kwargs):
        notification_commit_counts.append(db.commit_count)

    monkeypatch.setattr(call_routes, "_profile", fake_profile)
    monkeypatch.setattr(call_routes, "require_friends", fake_require_friends)
    monkeypatch.setattr(call_routes, "_notify", fake_notify)

    response = await call_routes.create_call(
        data={"userId": str(callee_id), "callType": "video"},
        current_user={"id": str(caller_id)},
        db=db,
    )

    assert response["status"] == "ringing"
    assert response["callType"] == "video"
    assert len(relationship_checks) == 2
    assert notification_commit_counts == [1]  # Second transaction still holds its locks.
    assert db.commit_count == 2


class FakeAsyncSessionContext:
    def __init__(self, session):
        self.session = session
        self.active = False

    async def __aenter__(self):
        self.active = True
        return self.session

    async def __aexit__(self, exc_type, exc, tb):
        self.active = False
        return False


class FakeWebSocket:
    def __init__(self):
        self.events = []

    async def send_json(self, event):
        self.events.append(event)


@pytest.mark.asyncio
async def test_websocket_signaling_stops_if_friendship_is_missing(monkeypatch):
    from app.api import websocket as websocket_routes

    caller_id, callee_id, call_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    call = CallSession(
        id=call_id,
        caller_id=caller_id,
        callee_id=callee_id,
        status="accepted",
    )
    db = FakeSession([
        FakeResult(scalar=call),  # Non-locking call lookup.
        FakeResult(),             # No accepted friendship.
        FakeResult(scalar=call),  # Lock call after relationship check fails.
    ])
    websocket = FakeWebSocket()
    sent_to_users = []
    session_context = FakeAsyncSessionContext(db)
    context_state_when_sent = []

    async def fake_send_to_user(user_id, event):
        sent_to_users.append((user_id, event))
        context_state_when_sent.append(session_context.active)

    monkeypatch.setattr(websocket_routes, "AsyncSessionLocal", lambda: session_context)
    monkeypatch.setattr(websocket_routes.manager, "send_to_user", fake_send_to_user)

    await websocket_routes._handle_call_signal(
        websocket,
        str(caller_id),
        "call.ice",
        {"callId": str(call_id), "candidate": {"candidate": "candidate:1 1 UDP 1 127.0.0.1 9 typ host"}},
    )

    assert call.status == "completed"
    assert db.committed is True
    assert any(event["type"] == "call.error" for event in websocket.events)
    assert {target for target, _event in sent_to_users} == {str(caller_id), str(callee_id)}
    assert all(event["type"] == "call.ended" for _target, event in sent_to_users)
    assert context_state_when_sent and all(context_state_when_sent)


@pytest.mark.asyncio
async def test_websocket_signaling_relays_only_when_users_are_friends(monkeypatch):
    from app.api import websocket as websocket_routes

    caller_id, callee_id, call_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    call = CallSession(
        id=call_id,
        caller_id=caller_id,
        callee_id=callee_id,
        status="accepted",
    )
    db = FakeSession([
        FakeResult(scalar=call),
        FakeResult(scalar=uuid.uuid4()),  # Accepted friendship exists.
        FakeResult(scalar=call),
    ])
    websocket = FakeWebSocket()
    sent_to_users = []
    session_context = FakeAsyncSessionContext(db)
    context_state_when_sent = []

    async def fake_send_to_user(user_id, event):
        sent_to_users.append((user_id, event))
        context_state_when_sent.append(session_context.active)

    monkeypatch.setattr(websocket_routes, "AsyncSessionLocal", lambda: session_context)
    monkeypatch.setattr(websocket_routes.manager, "send_to_user", fake_send_to_user)

    await websocket_routes._handle_call_signal(
        websocket,
        str(caller_id),
        "call.ice",
        {"callId": str(call_id), "candidate": {"candidate": "candidate:1 1 UDP 1 127.0.0.1 9 typ host"}},
    )

    assert len(sent_to_users) == 1
    assert sent_to_users[0][0] == str(callee_id)
    assert sent_to_users[0][1]["type"] == "call.ice"
    assert context_state_when_sent == [True]
    assert call.status == "accepted"


@pytest.mark.asyncio
async def test_conversation_list_batches_database_reads_and_preserves_payload():
    from app.api.conversations import get_conversations
    from app.models.attachment import Attachment
    from app.models.message import Message
    from app.models.profiles import Profile

    current_user_id, friend_id, group_member_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    conversation_id, group_conversation_id = uuid.uuid4(), uuid.uuid4()
    low_id, high_id = canonical_pair(current_user_id, friend_id)
    now = datetime.now(timezone.utc)
    current_user_profile = Profile(
        id=current_user_id,
        username="current",
        display_name="Current User",
        avatar_url=None,
        created_at=now,
        updated_at=now,
    )
    friend_profile = Profile(
        id=friend_id,
        username="friend",
        display_name="Friend Name",
        avatar_url="https://example.invalid/friend.png",
        created_at=now,
        updated_at=now,
    )
    conversation = Conversation(
        id=conversation_id,
        type="direct",
        name=None,
        created_at=now,
        updated_at=now,
    )
    group_conversation = Conversation(
        id=group_conversation_id,
        type="group",
        name="Project Group",
        created_at=now,
        updated_at=now,
    )
    group_profile = Profile(
        id=group_member_id,
        username="group-member",
        display_name="Group Member",
        avatar_url=None,
        created_at=now,
        updated_at=now,
    )
    message = Message(
        id=uuid.uuid4(),
        conversation_id=conversation_id,
        sender_id=friend_id,
        content="Latest message",
        created_at=now,
        status="sent",
    )
    group_message = Message(
        id=uuid.uuid4(),
        conversation_id=group_conversation_id,
        sender_id=group_member_id,
        content="Group update",
        created_at=now,
        status="sent",
    )
    attachment = Attachment(
        id=uuid.uuid4(),
        message_id=message.id,
        file_name="photo.png",
        mime_type="image/png",
        file_size=1234,
        storage_path="unit-test/photo.png",
        created_at=now,
    )
    db = FakeSession(
        [
            FakeResult(rows=[conversation, group_conversation]),
            FakeResult(rows=[
                (conversation_id, current_user_profile, "member"),
                (conversation_id, friend_profile, "member"),
                (group_conversation_id, current_user_profile, "member"),
                (group_conversation_id, group_profile, "member"),
            ]),
            FakeResult(rows=[message, group_message]),
            FakeResult(rows=[attachment]),
            FakeResult(rows=[(low_id, high_id)]),
            FakeResult(rows=[]),
        ]
    )

    response = await get_conversations(current_user={"id": str(current_user_id)}, db=db)

    assert len(db.statements) == 6  # Constant query count; no per-conversation SQL loop.
    from sqlalchemy.dialects import postgresql
    latest_message_sql = str(
        db.statements[2].compile(dialect=postgresql.dialect())
    )
    assert "LIMIT" in latest_message_sql.upper()
    assert "ROW_NUMBER" not in latest_message_sql.upper()
    assert len(response) == 2
    item = next(item for item in response if item["id"] == str(conversation_id))
    assert item["participantId"] == str(friend_id)
    assert item["participantName"] == "Friend Name"
    assert item["relationshipStatus"] == "friends"
    assert item["friendRequestId"] is None
    assert item["lastMessage"]["content"] == "Latest message"
    assert item["lastMessage"]["attachments"] == [
        {
            "id": str(attachment.id),
            "fileName": "photo.png",
            "mimeType": "image/png",
            "size": 1234,
        }
    ]
    assert {participant["id"] for participant in item["participants"]} == {
        str(current_user_id),
        str(friend_id),
    }
    group_item = next(item for item in response if item["id"] == str(group_conversation_id))
    assert group_item["type"] == "group"
    assert group_item["participantName"] == "Project Group"
    assert group_item["relationshipStatus"] == "group"
    assert group_item["lastMessage"]["content"] == "Group update"


@pytest.mark.asyncio
async def test_conversation_list_reports_pending_request_from_peer():
    from app.api.conversations import get_conversations
    from app.models.profiles import Profile
    from app.models.friend_request import FriendRequest

    current_user_id, peer_id, conversation_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    now = datetime.now(timezone.utc)
    current_profile = Profile(
        id=current_user_id, username="current", display_name="Current", avatar_url=None,
        created_at=now, updated_at=now,
    )
    peer_profile = Profile(
        id=peer_id, username="peer", display_name="Peer", avatar_url=None,
        created_at=now, updated_at=now,
    )
    conversation = Conversation(
        id=conversation_id, type="direct", name=None, created_at=now, updated_at=now,
    )
    request = FriendRequest(
        id=uuid.uuid4(),
        user_low_id=min(current_user_id, peer_id, key=lambda item: item.int),
        user_high_id=max(current_user_id, peer_id, key=lambda item: item.int),
        sender_id=peer_id,
        recipient_id=current_user_id,
        status="pending",
        created_at=now,
    )
    db = FakeSession([
        FakeResult(rows=[conversation]),
        FakeResult(rows=[
            (conversation_id, current_profile, "member"),
            (conversation_id, peer_profile, "member"),
        ]),
        FakeResult(rows=[]),  # No messages.
        FakeResult(rows=[]),  # No friendship.
        FakeResult(rows=[request]),
    ])

    response = await get_conversations(current_user={"id": str(current_user_id)}, db=db)
    assert response[0]["relationshipStatus"] == "request_received"
    assert response[0]["friendRequestId"] == str(request.id)
    assert response[0]["lastMessage"] is None
    assert len(db.statements) == 5


@pytest.mark.asyncio
async def test_rejected_friend_request_can_be_retried_without_duplicate_row():
    from app.api.v1.users.friendships import send_friend_request
    from app.models.friend_request import FriendRequest
    from app.models.profiles import Profile

    sender_id, recipient_id = uuid.uuid4(), uuid.uuid4()
    low_id, high_id = canonical_pair(sender_id, recipient_id)
    now = datetime.now(timezone.utc)
    recipient = Profile(
        id=recipient_id, username="recipient", display_name="Recipient", avatar_url=None,
        created_at=now, updated_at=now,
    )
    request = FriendRequest(
        id=uuid.uuid4(),
        user_low_id=low_id,
        user_high_id=high_id,
        sender_id=recipient_id,
        recipient_id=sender_id,
        status="rejected",
        created_at=now,
        responded_at=now,
    )
    db = FakeSession([
        FakeResult(scalar=recipient),
        FakeResult(scalar=request),
        FakeResult(),  # No accepted friendship.
    ])

    result = await send_friend_request(
        data={"userId": str(recipient_id)},
        current_user={"id": str(sender_id)},
        db=db,
    )

    assert result["status"] == "pending"
    assert request.sender_id == sender_id
    assert request.recipient_id == recipient_id
    assert request.status == "pending"
    assert request.responded_at is None
    assert db.commit_count == 1
    assert len(db.added) == 0  # Reuses the canonical pair row instead of inserting another.


@pytest.mark.asyncio
async def test_accept_friend_request_persists_friendship_and_request_status():
    from app.api.v1.users.friendships import accept_friend_request
    from app.models.friend_request import FriendRequest

    sender_id, recipient_id = uuid.uuid4(), uuid.uuid4()
    low_id, high_id = canonical_pair(sender_id, recipient_id)
    request = FriendRequest(
        id=uuid.uuid4(),
        user_low_id=low_id,
        user_high_id=high_id,
        sender_id=sender_id,
        recipient_id=recipient_id,
        status="pending",
        created_at=datetime.now(timezone.utc),
    )
    db = FakeSession([
        FakeResult(scalar=request),
        FakeResult(),  # INSERT ... ON CONFLICT DO NOTHING.
    ])

    result = await accept_friend_request(
        request_id=request.id,
        current_user={"id": str(recipient_id)},
        db=db,
    )

    assert result == {"success": True, "status": "accepted", "friendId": str(sender_id)}
    assert request.status == "accepted"
    assert request.responded_at is not None
    assert db.committed is True
    assert "friendships" in str(db.statements[1])
