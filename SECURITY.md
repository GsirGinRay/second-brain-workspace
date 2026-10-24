# Security Policy

Please report security issues privately instead of opening a public issue:
on GitHub, open the **Security** tab of this repository and choose **Report a
vulnerability**.

The desktop application is local-first. It only reads and writes the Markdown
folder the user selected. It goes online only for signed updates and, once a
phone is paired, for the end-to-end encrypted phone inbox
([docs/inbox-relay.md](docs/inbox-relay.md)).

Never attach a real vault, pairing link, private key, access token or `.env`
file to an issue.
