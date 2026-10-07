from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, set[WebSocket]] = {}

    async def connect(self, user_id: str, websocket: WebSocket):
        await websocket.accept()

        if user_id not in self.active_connections:
            self.active_connections[user_id] = set()

        self.active_connections[user_id].add(websocket)

    def disconnect(self, user_id: str, websocket: WebSocket):
        connections = self.active_connections.get(user_id)

        if not connections:
            return

        connections.discard(websocket)

        if not connections:
            del self.active_connections[user_id]

    async def send_to_user(self, user_id: str, message: dict):
        connections = self.active_connections.get(user_id)

        if not connections:
            return

        disconnected = []

        for websocket in connections:
            try:
                await websocket.send_json(message)
            except Exception:
                disconnected.append(websocket)

        for websocket in disconnected:
            connections.discard(websocket)

        if not connections:
            self.active_connections.pop(user_id, None)


manager = ConnectionManager()