"""Pure parts of Markdown documents shared by canvases and wiki pages (docs/WIKI.md §2.3, M120).

merge (the three-way merge), markers (task markers), body (cleanup, tasks, line diff, image and
mention references), save (the save flow: idempotency key → base → merge → side version → head)
and revisions (the thinning policy). Nothing here knows about conversations or pages: the modules
pass in how to load rows, check access and emit events.
"""
