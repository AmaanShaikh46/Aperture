import uuid
"""Presence connection lifecycle unit tests without a live WebSocket server."""
import pytest

from app.services.connection_manager import ConnectionManager


class FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.sent = []

    async def accept(self):
        self.accepted = True

    async def send_json(self, payload):
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_multiple_connections_only_transition_online_once_and_offline_on_final_disconnect():
    manager = ConnectionManager()
    first = FakeWebSocket()
    second = FakeWebSocket()

    assert await manager.connect("user-1", first) is True
    assert await manager.connect("user-1", second) is False
    assert first.accepted and second.accepted

    assert manager.disconnect("user-1", first) is False
    assert "user-1" in manager.active_connections
    assert manager.disconnect("user-1", second) is True
    assert "user-1" not in manager.active_connections


def test_disconnect_of_unknown_connection_does_not_emit_offline_transition():
    manager = ConnectionManager()
    assert manager.disconnect("missing-user", FakeWebSocket()) is False


def test_presence_router_exposes_snapshot_and_preference_routes():
    from app.api.presence import router

    routes = {(route.path, tuple(sorted(route.methods or []))) for route in router.routes}
    assert ("/api/presence/settings", ("GET",)) in routes
    assert ("/api/presence/settings", ("PATCH",)) in routes
    assert ("/api/presence/{user_id}", ("GET",)) in routes

# Presence service authorization and privacy tests.
from datetime import datetime, timezone
from types import SimpleNamespace

from app.services import presence_service


class PresenceFakeResult:
    def __init__(self, scalar=None, rows=None):
        self.scalar = scalar
        self.rows = list(rows or [])

    def scalar_one_or_none(self):
        return self.scalar

    def scalars(self):
        return self

    def all(self):
        return self.rows


class PresenceFakeSession:
    def __init__(self, results):
        self.results = list(results)

    async def execute(self, statement):
        if not self.results:
            raise AssertionError("Unexpected database query in presence test")
        return self.results.pop(0)


def make_friendship(user_a, user_b):
    low, high = sorted((user_a, user_b), key=lambda value: value.int)
    return SimpleNamespace(user_low_id=low, user_high_id=high)


@pytest.mark.asyncio
async def test_presence_snapshot_allows_accepted_friend_and_hides_last_seen_while_online(monkeypatch):
    viewer_id, target_id = uuid.uuid4(), uuid.uuid4()
    profile = SimpleNamespace(
        id=target_id,
        share_last_seen=True,
        last_seen_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    db = PresenceFakeSession([
        PresenceFakeResult(scalar=uuid.uuid4()),
        PresenceFakeResult(scalar=profile),
    ])
    monkeypatch.setattr(
        presence_service.manager,
        "active_connections",
        {str(target_id): {object()}},
    )

    result = await presence_service.get_presence_snapshot(db, viewer_id, target_id)

    assert result == {
        "userId": str(target_id),
        "presence": "online",
        "lastSeen": None,
    }


@pytest.mark.asyncio
async def test_presence_snapshot_rejects_nonfriend():
    viewer_id, target_id = uuid.uuid4(), uuid.uuid4()
    db = PresenceFakeSession([PresenceFakeResult()])

    with pytest.raises(PermissionError, match="accepted friends"):
        await presence_service.get_presence_snapshot(db, viewer_id, target_id)


@pytest.mark.asyncio
async def test_presence_snapshot_rejects_self_query():
    user_id = uuid.uuid4()

    with pytest.raises(PermissionError, match="own friend presence"):
        await presence_service.get_presence_snapshot(
            PresenceFakeSession([]), user_id, user_id
        )


@pytest.mark.asyncio
async def test_presence_snapshot_hides_status_when_sharing_is_disabled(monkeypatch):
    viewer_id, target_id = uuid.uuid4(), uuid.uuid4()
    profile = SimpleNamespace(
        id=target_id,
        share_last_seen=False,
        last_seen_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    db = PresenceFakeSession([
        PresenceFakeResult(scalar=uuid.uuid4()),
        PresenceFakeResult(scalar=profile),
    ])
    monkeypatch.setattr(presence_service.manager, "active_connections", {})

    result = await presence_service.get_presence_snapshot(db, viewer_id, target_id)

    assert result == {
        "userId": str(target_id),
        "presence": "hidden",
        "lastSeen": None,
    }


@pytest.mark.asyncio
async def test_hidden_presence_broadcast_never_includes_last_seen(monkeypatch):
    user_id, friend_id = uuid.uuid4(), uuid.uuid4()
    profile = SimpleNamespace(id=user_id, share_last_seen=False, last_seen_at=None)
    db = PresenceFakeSession([
        PresenceFakeResult(scalar=profile),
        PresenceFakeResult(rows=[make_friendship(user_id, friend_id)]),
    ])
    sent = []

    async def capture_send(target_user_id, event):
        sent.append((target_user_id, event))

    monkeypatch.setattr(presence_service.manager, "active_connections", {})
    monkeypatch.setattr(presence_service.manager, "send_to_user", capture_send)

    await presence_service.broadcast_presence(db, user_id)

    assert len(sent) == 1
    assert sent[0][0] == str(friend_id)
    assert sent[0][1]["payload"] == {
        "userId": str(user_id),
        "presence": "hidden",
        "lastSeen": None,
    }


@pytest.mark.asyncio
async def test_disconnect_finalizer_skips_last_seen_if_user_reconnects(monkeypatch):
    from app.api import websocket as websocket_routes

    user_id = str(uuid.uuid4())
    manager = ConnectionManager()
    socket = FakeWebSocket()
    await manager.connect(user_id, socket)

    # Isolate this test from the module-global manager.
    monkeypatch.setattr(websocket_routes, "manager", manager)
    monkeypatch.setattr(websocket_routes, "PRESENCE_DISCONNECT_GRACE_SECONDS", 0)

    async def should_not_persist(*args, **kwargs):
        raise AssertionError("Last-seen must not persist while user is online")

    monkeypatch.setattr(websocket_routes, "persist_last_seen", should_not_persist)

    await websocket_routes._finalize_presence_disconnect(user_id)

    assert user_id in manager.active_connections


@pytest.mark.asyncio
async def test_disconnect_finalizer_persists_last_seen_when_no_connections(monkeypatch):
    from app.api import websocket as websocket_routes

    user_id = str(uuid.uuid4())
    monkeypatch.setattr(websocket_routes, "manager", ConnectionManager())
    monkeypatch.setattr(websocket_routes, "PRESENCE_DISCONNECT_GRACE_SECONDS", 0)

    persisted = []
    broadcast = []

    async def fake_persist(db, target_id):
        persisted.append(target_id)

    async def fake_broadcast(db, target_id):
        broadcast.append(target_id)

    class FakeDBContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(websocket_routes, "AsyncSessionLocal", FakeDBContext)
    monkeypatch.setattr(websocket_routes, "persist_last_seen", fake_persist)
    monkeypatch.setattr(websocket_routes, "broadcast_presence", fake_broadcast)

    await websocket_routes._finalize_presence_disconnect(user_id)

    assert persisted == [uuid.UUID(user_id)]
    assert broadcast == [uuid.UUID(user_id)]

@pytest.mark.asyncio
async def test_websocket_reconnect_cancels_pending_presence_disconnect(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from fastapi import WebSocketDisconnect
    from app.api import websocket as websocket_routes

    user_id = str(uuid.uuid4())
    manager = ConnectionManager()
    socket = FakeWebSocket()
    await manager.connect(user_id, socket)

    # Simulate a task already waiting to finalize the previous disconnect.
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def pending_disconnect():
        started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    pending_task = asyncio.create_task(pending_disconnect())
    await started.wait()

    monkeypatch.setattr(websocket_routes, "manager", manager)
    monkeypatch.setattr(
        websocket_routes,
        "_presence_disconnect_tasks",
        {user_id: pending_task},
    )
    monkeypatch.setattr(
        websocket_routes,
        "verify_access_token",
        lambda _token: asyncio.sleep(0, result={"id": user_id}),
    )

    class ReconnectSocket(FakeWebSocket):
        query_params = {"token": "unit-test-token"}

        def __init__(self):
            super().__init__()
            self.receive_calls = 0
            self.closed = []

        async def receive_text(self):
            self.receive_calls += 1
            raise WebSocketDisconnect()

        async def close(self, code):
            self.closed.append(code)

    reconnect_socket = ReconnectSocket()

    async def no_db_broadcast(*args, **kwargs):
        pass

    async def no_call_cleanup(*args, **kwargs):
        pass

    monkeypatch.setattr(websocket_routes, "broadcast_presence", no_db_broadcast)
    monkeypatch.setattr(websocket_routes, "_finish_calls_after_last_disconnect", no_call_cleanup)

    try:
        await websocket_routes.websocket_endpoint(reconnect_socket)
        await asyncio.sleep(0)
        assert cancelled.is_set()
        assert user_id not in websocket_routes._presence_disconnect_tasks
    finally:
        if not pending_task.done():
            pending_task.cancel()
        await asyncio.gather(pending_task, return_exceptions=True)
