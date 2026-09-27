"""Events emitted by the channel_links module (SYNC_PROTOCOL.md §6): audience channel, no seq."""

from app.modules.channel_links.schemas import ChannelLinksUpdatedData

CHANNEL_LINKS_UPDATED = "channel.links_updated"

__all__ = ["CHANNEL_LINKS_UPDATED", "ChannelLinksUpdatedData"]
