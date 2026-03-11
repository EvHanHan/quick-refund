# 1-click Navan refund chrome extension 
<img width="563" height="397" alt="SCR-20260305-jwkt" src="https://github.com/user-attachments/assets/48c0d281-5aed-41b5-9ffe-29ed95c47ed3" />

## Setup
Go to the release section and download the lastest release. 
This will help us track the number of downloads. 

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
1. asks provider + br 15 minutes inactivity.
- User manually performs final submit in Navan.
- Orange PDF byte capture uses Chrome DevTools Protocol (`debugger` permission).

## Note
[Product story – the why?](https://github.com/EvHanHan/quick-refund/wiki/Product-story-%E2%80%90-the-why%3F)

## What does user say
<img width="608" height="152" alt="image" src="https://github.com/user-attachments/assets/e42d33b1-e775-44fa-b536-67b727390963" />
<img width="416" height="479" alt="image" src="https://github.com/user-attachments/assets/996d7cfd-2883-4410-9dbb-6b8ad5aaa244" />

