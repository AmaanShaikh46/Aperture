import uuid

import pytest

from app.api.websocket import _handle_call_assist_message
from app.services.connection_manager import ConnectionManager


class FakeWebSocket:
    def __init__(self, fail_send=False):
        self.sent = []
        self.fail_send = fail_send

    async def send_json(self, payload):
        if self.fail_send:
            raise RuntimeError("socket is unavailable")
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_call_assist_validation_error_includes_call_and_message_ids():
    websocket = FakeWebSocket()
    call_id = str(uuid.uuid4())
    message_id = str(uuid.uuid4())

    await _handle_call_assist_message(
        websocket,
        str(uuid.uuid4()),
        {
            "callId": call_id,
            "messageId": message_id,
            "text": "Hello",
            "speak": "yes",
        },
    )

    assert websocket.sent == [
        {
            "type": "call.assist.message.error",
            "payload": {
                "detail": "The speak flag must be a boolean.",
                "messageId": message_id,
                "callId": call_id,
            },
        }
    ]


@pytest.mark.asyncio
async def test_connection_manager_reports_delivery_to_at_least_one_recipient_socket():
    manager = ConnectionManager()
    unavailable = FakeWebSocket(fail_send=True)
    available = FakeWebSocket()
    manager.active_connections["recipient"] = {unavailable, available}

    delivered = await manager.send_to_user("recipient", {"type": "call.assist.message"})

    assert delivered is True
    assert available.sent == [{"type": "call.assist.message"}]
    assert manager.active_connections["recipient"] == {available}


@pytest.mark.asyncio
async def test_connection_manager_returns_false_when_recipient_is_offline():
    manager = ConnectionManager()

    assert await manager.send_to_user("offline-recipient", {"type": "call.assist.message"}) is False
