"""add unique constraint to contacts

Revision ID: 5dddd85cbf87
Revises: 7a9c81619448
Create Date: 2026-10-07 23:07:33.244344

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '5dddd85cbf87'
down_revision: Union[str, Sequence[str], None] = '7a9c81619448'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_unique_constraint(
        'uq_contacts_user_contact',
        'contacts',
        ['user_id', 'contact_user_id'],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(
        'uq_contacts_user_contact',
        'contacts',
        type_='unique',
    )