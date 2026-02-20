# 1-click Navan refund Navan Chrome Extension 
## Setup
1. Download the latest release zip file
2. Unzip it
4. Open your chome and open your extensions 
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the unzip file.

## How to use? 
1. Open the extension
2. Enter your provider credentials, choose **Home internet** or **Mobile internet**, then click **Start Flow**.

### How to handle exception
4. If the provider shows a captcha, solve it in the webpage then comes back to click **Resume**.
5. Complete Google SSO in Navan when prompted, then click **Resume**.

## Technical flow 
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

## Notes
- Selectors are best-effort and should be hardened against your tenant-specific UI.
- Ensure automation complies with Orange/Navan terms and your company policy.

## Run tests
```bash
npm test
```
