# Benchmark pilot installation and acceptance

## Before installation

1. Confirm the API and web workflows are running.
2. This pilot uses useSend Cloud's API. In Replit Secrets, set `USESEND_API_KEY` to the useSend Cloud API key and `USESEND_FROM_EMAIL` to a sender address verified with useSend. Never put the API key in source control or logs. Do not use a homeowner's address as the sender; it is used only for reply-to. A self-hosted useSend instance would require configuring its own API base URL before testing.
3. Sign in as the Benchmark contractor. Open **Contractor setup**, enter the company name, website (`yourcompany.com` or a full `https://` URL), and the quote inbox. Save. A no-auth click-through is also available at `/demo`, with the contractor preview at `/inbox`.
4. Open **Widget embed**. Copy the iframe snippet. Its tenant-specific URL is stable; do not replace the ID with `benchmark`. Changing the quote inbox later does not require reinstalling the snippet.

## Install and test

- Paste the iframe into a plain HTML page on a separate origin, then into Benchmark's staging page. Leave enough vertical room for its 900-pixel scrollable viewport; on small screens use `width="100%"`.
- From a phone, upload a real indoor room photo (JPG, PNG, WebP, under 10 MB). The sample image in the interface is illustrative only, not submitted.
- Try one kitchen and one bathroom concept. Check that the results reflect the brief, keep the room recognizable, and show relevant **rough planning notes**, not measurements or prices.
- Send test leads with an email address you can check. Confirm the quote inbox receives the contact information, brief, room-specific scope checklist, and **both PNG attachments**. Open the attachments in a mobile mail client as well.
- Record the reference ID and save the private deletion link shown after submission. Check that the lead appears in the signed-in **Saved requests** view and that another contractor's account cannot retrieve it.
- Submit an invalid file and a non-room photo; confirm they show a helpful message, not a sent confirmation. Test an already-used submission button/retry without generating a duplicate message.
- If email is not configured or the provider rejects the send, the form stays available. Retry the identical request without changing details or the request key; do not issue a second lead manually while the provider outcome is uncertain.

## Pilot operating notes

- The image-edit endpoint uses the contractor's monthly AI allowance; five redesign requests per IP per hour and ten lead submissions per IP per hour are additionally limited. These are pilot guardrails, not a guarantee against distributed abuse.
- Submitted request details and images are private and expire after 90 days. The contractor can delete a lead sooner; the homeowner receives a private deletion link only after the email is accepted.
- Do not interpret the AI concept or checklist as a priced estimate or construction specification.
- Measure AI image-edit reservations, classification calls, email acceptance, and storage footprint for the test leads before finalizing monthly pricing. The current usage allowance tracks *estimated reserved image-edit spend*, not actual provider invoices; classification, email, and storage require separate billing reports.
- Benchmark staging installation, actual inbox delivery, and an eventual quote based on a pilot lead need confirmation with Benchmark; a development preview alone cannot establish those outcomes.