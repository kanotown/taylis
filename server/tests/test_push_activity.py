"""Whether a user is "using another device" for push (PUSH_NOTIFICATIONS.md §4.1)."""

import uuid

from app.realtime.hub import RealtimeHub


def test_activity_belongs_to_the_connection() -> None:
    hub = RealtimeHub()
    user = uuid.uuid4()
    phone = hub.new_connection(user, uuid.uuid4())
    assert hub.is_active(
        user, within_seconds=60
    )  # connecting counts: apps connect in the foreground

    # The phone goes to the background: from now on its pushes are not held back for a minute.
    hub.mark_active(phone, False)
    assert not hub.is_active(user, within_seconds=60)

    hub.mark_active(phone, True)
    assert hub.is_active(user, within_seconds=60)
    hub.remove(phone)  # a closed app (suspended socket) counts no more either
    assert not hub.is_active(user, within_seconds=60)


def test_another_device_in_use_still_holds_pushes_back() -> None:
    hub = RealtimeHub()
    user = uuid.uuid4()
    phone = hub.new_connection(user, uuid.uuid4())
    laptop = hub.new_connection(user, uuid.uuid4())
    hub.mark_active(phone, False)
    hub.mark_active(laptop, True)
    assert hub.is_active(user, within_seconds=60)
    hub.mark_active(laptop, False)
    assert not hub.is_active(user, within_seconds=60)
    assert hub.presence_status(user) == "away"  # still connected, nobody using it
