import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation_participants import ConversationParticipant
from app.services.connection_manager import manager


logger = logging.getLogger(__name__)


async def broadcast_profile_updated(
    db: AsyncSession,
    user_id: uuid.UUID,
    display_name: str,
    username: str,
    avatar_url: str | None,
) -> None:
    """
    Notify the user and their conversation partners that their
    public chat profile has changed.

    Profile changes are already committed before this function runs.
    Notification failures must not undo a successful profile update.
    """
    try:
        result = await db.execute(
            select(ConversationParticipant.user_id)
            .where(
                ConversationParticipant.conversation_id.in_(
                    select(ConversationParticipant.conversation_id).where(
                        ConversationParticipant.user_id == user_id
                    )
                )
            )
            .distinct()
        )

        recipient_ids = {
            str(participant_id)
            for participant_id in result.scalars().all()
        }

        # Include the profile owner so their other logged-in sessions update.
        recipient_ids.add(str(user_id))

        event = {
            "type": "profile.updated",
            "payload": {
                "userId": str(user_id),
                "displayName": display_name,
                "username": username,
                "avatarUrl": avatar_url,
            },
        }

        for recipient_id in recipient_ids:
            await manager.send_to_user(recipient_id, event)

    except Exception:
        # A realtime notification failure must not invalidate a saved profile.
        logger.exception(
            "Could not broadcast profile update for user %s",
            user_id,
        )