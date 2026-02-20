# Quick-refund Navan Chrome Extension (MV3)

Private unpacked Chrome extension that:
1. asks credentials about your mobile or internet provider
2. Logs into the provider and navigates billing.
3. Downloads/extracts the billing document file.
4. Opens Navan and pauses for user Google SSO.
5. Navigates to update page where you can drag and drop to create a trasaction

## Security defaults
- Passwords are not written to storage and are held only in memory during a run.
- Flow state is cleared after completion/failure or 15 minutes inactivity.
- User manually performs final submit in Navan.

## Local setup
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repo folder.
4. Pin extension and open popup.
5. Enter Orange credentials, choose **Home internet** or **Mobile internet**, then click **Start Flow**.
6. If Orange shows a captcha, solve it in the Orange tab then click **Resume**.
7. Complete Google SSO in Navan when prompted, then click **Resume**.

## Notes
- Selectors are best-effort and should be hardened against your tenant-specific UI.
- Ensure automation complies with Orange/Navan terms and your company policy.

## Run tests
```bash
npm test
```
