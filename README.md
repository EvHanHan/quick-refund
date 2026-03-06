# 1-click Navan refund chrome extension 
## Setup
1. Download the latest release zip file
2. Unzip it
4. Open your chome and open your extensions 
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the unzipped file.
4. You are ready to go 

## How to use? 
Video demo: 
https://youtu.be/dusQxY_aq6s

1. Open the extension
2. Choose your provider and billing type, then click **Start Flow**.
3. On provider login, enter your username/password directly on the provider website.
4. The flow resumes automatically after provider login is detected. If needed, click **Resume**.

### How to handle exception
1. If the provider shows a captcha, solve it in the webpage then come back to click **Resume**.
2. Complete Google SSO in Navan when prompted, then click **Resume**.

## Technical flow 
Private unpacked Chrome extension that:
1. asks provider + billing type for your mobile or internet bill
2. Logs into the provider and navigates billing.
3. Downloads/extracts the billing document file.
4. Opens Navan and pauses for user Google SSO.
5. Automatically uploads the invoice document in Navan when PDF bytes are captured.
6. Falls back to manual upload only if provider capture or Navan attachment fails.

## Security defaults
- Flow state is cleared after completion/failure or 15 minutes inactivity.
- User manually performs final submit in Navan.
- Orange PDF byte capture uses Chrome DevTools Protocol (`debugger` permission).


## Notes
- Selectors are best-effort and should be hardened against your tenant-specific UI.
- Ensure automation complies with Orange/Navan terms and your company policy.

## Run tests
```bash
npm test
```
