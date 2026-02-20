# 1-click Navan refund chrome extension 
## Setup
1. Download the latest release zip file
2. Unzip it
4. Open your chome and open your extensions 
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the unzip file.

## How to use? 
1. Open the extension
2. Enter your provider username, choose **Home internet** or **Mobile internet**, then click **Start Flow**.
3. On provider login, use Chrome autofill/password manager or login manually.
4. If login is not completed automatically, enter password in popup and click **Resume**.

### How to handle exception
1. If the provider shows a captcha, solve it in the webpage then come back to click **Resume**.
2. Complete Google SSO in Navan when prompted, then click **Resume**.

## Technical flow 
Private unpacked Chrome extension that:
1. asks credentials about your mobile or internet provider
2. Logs into the provider and navigates billing.
3. Downloads/extracts the billing document file.
4. Opens Navan and pauses for user Google SSO.
5. Navigates to update page where you can drag and drop to create a trasaction

## Security defaults
- Password is never written to `chrome.storage.local`.
- Legacy cached passwords are purged from prior versions.
- Password is kept in memory only for the active run and cleared after provider authentication.
- Flow state is cleared after completion/failure or 15 minutes inactivity.
- User manually performs final submit in Navan.

## Notes
- Selectors are best-effort and should be hardened against your tenant-specific UI.
- Ensure automation complies with Orange/Navan terms and your company policy.

## Run tests
```bash
npm test
```
