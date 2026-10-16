# Store listing (English, short)

For an English localization in App Store Connect / Play Console. The Japanese listing (LISTING_JA.md) is the primary one.
The App Store values are also in `docs/store/appstore.json` (`en-US`), which `apps/ios/scripts/asc-metadata.py` reads; change both.

| Field | Value |
|---|---|
| Name | iOS: Taylis - Team Chat for Labs (27) / Play: Taylis |
| Subtitle (iOS ≤ 30) | Self-hosted chat for labs (25) |
| Category | Business (secondary: Productivity) |
| Privacy policy | https://kano.ac/pages/apps/taylis-privacy-policy/ |
| Support | https://kano.ac/pages/apps/taylis-support/ |
| Account deletion (Play) | https://kano.ac/pages/apps/taylis-account-deletion/ |

## Promotional text (iOS ≤ 170)

Attendance board, weekly report tracking, students' work logs, acknowledged notices, deadlines and tasks: everyday lab communication in one app on your own server. (163)

## Keywords (iOS ≤ 100)

university,seminar,attendance,weekly report,work log,self-hosted,tasks,deadlines,calendar,widgets (97)

## Short description (Play ≤ 80)

Channel and thread chat that your lab or team runs on its own server (68)

## Description

Taylis is a chat app for university research labs that run their own Taylis server. Messages are stored only on the server your lab operates; nothing is sent to the developer or to advertisers.

Note: you need an account on a Taylis server run by your organization. Accounts are created by the server administrator; there is no public sign-up.
The server is open source (Apache License 2.0). To run your own, see https://github.com/kanotown/taylis

For research labs:
- Attendance board: in the lab, on campus, off campus or gone home, with one tap; see who is in the lab at a glance
- Weekly reports: a thread every week that shows who has submitted and the deadline
- Times: each student's work log channel, all in one feed
- Acknowledgement requests: add a confirm button to important notices and see who has read them
- Deadline countdowns, tasks and a calendar
- A queue for shared equipment and software seats
- Home Screen widgets for attendance, unread messages and today's events and deadlines

Chat:
- Public and private channels, direct and group messages
- Threads, mentions, reactions (emoji, text reactions and your organization's stickers)
- Full-text search in Japanese and English, filtered by person, channel and date
- Photo, video and file attachments, and sharing from other apps
- Polls and scheduling
- Push notifications with per-channel settings and quiet hours; the app always resyncs with the server
- Switch between several servers

Safety:
- Report messages, block users, delete your own messages and delete your account in the app
- Two-factor authentication, and sign-in with your organization's Google account when the server allows it

Optional AI features (a bot and summaries) are available only when your server administrator enables them; conversation content is then sent to the AI provider the administrator chose.
