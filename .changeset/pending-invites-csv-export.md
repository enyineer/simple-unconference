---
"simple-unconference": minor
---

Moderators can now export all pending invites as CSV from the People tab.

The "Pending invites" section now has a "Download CSV" button (visible to moderators and owners) that downloads every still-unclaimed invite with `email, role, token, url, created_at, expires_at`. The file is RFC 4180-escaped and ships with a UTF-8 BOM so Excel opens non-ASCII addresses correctly. Useful for feeding invite links into mail-merge tools or other systems without copying each row by hand.
