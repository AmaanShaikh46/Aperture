import logging

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, set[WebSocket]] = {}

    async def connect(self, user_id: str, websocket: WebSocket) -> bool:
        await websocket.accept()
        connections = self.active_connections.setdefault(user_id, set())
        was_offline = not connections
        connections.add(websocket)
        return was_offline

    def disconnect(self, user_id: str, websocket: WebSocket) -> bool:
        connections = self.active_connections.get(user_id)
        if not connections:
            return False

        connections.discard(websocket)
        if not connections:
            self.active_connections.pop(user_id, None)
            return True
        return False

    async def send_to_user(self, user_id: str, message: dict) -> bool:
        """Send to every active connection and report whether at least one received it."""
        connections = self.active_connections.get(user_id)
        if not connections:
            return False

        delivered = False
        # Snapshot before awaiting network I/O. The live set may change when
        # another connection disconnects while this method is suspended.
        for websocket in list(connections):
            try:
                await websocket.send_json(message)
                delivered = True
            except Exception:
                logger.debug(
                    "Dropping an unavailable WebSocket for user %s",
                    user_id,
                    exc_info=True,
                )
                self.disconnect(user_id, websocket)
        return delivered


manager = ConnectionManager()
