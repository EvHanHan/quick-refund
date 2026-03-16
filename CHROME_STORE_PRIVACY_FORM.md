# Chrome Web Store Privacy Form Answers

## Single purpose
Automatically retrieve telecom/transit invoices and prefill a Navan expense upload flow with one click.

## Permission justification

### storage justification
Stores local user preferences (provider, billing type, reminder setting), reminder schedule state, and temporary flow state in `chrome.storage.local`.

### scripting justification
Runs extension scripts in the active provider/Navan tab to detect billing pages, retrieve invoice files, and populate Navan upload form fields.

### tabs justification
Creates/updates tabs for provider billing pages and Navan upload page, and tracks tab load completion during the guided workflow.

### activeTab justification
Performs user-initiated actions only on the currently active provider/Navan tab when the workflow starts from the popup.

### alarms justification
Schedules monthly reimbursement reminders and periodic cleanup of temporary local cache entries.

### notifications justification
Shows monthly reminder notifications and opens the extension popup when the reminder notification is clicked.

### debugger justification
Temporarily attaches Chrome Debugger only on supported provider tabs to capture invoice PDF network responses when direct page download is unavailable.

### host permission justification
Needs access to listed provider domains and `app.navan.com` to run the invoice retrieval and Navan upload flow end-to-end. `raw.githubusercontent.com` is used only to check latest extension version metadata.

## Remote code
No, I am not using remote code.

Reason (if text box appears):
The extension executes only packaged local scripts. Remote fetch is limited to data/metadata (invoice PDFs from user-authorized provider sessions and a remote manifest version check), not executable code.

## Data usage
For **What user data do you collect?**, select **Yes**, then check:

- Personal financial info (invoice/receipt content)
- Website content (page content needed to locate billing/download/upload UI)

For each selected data type:

- Purpose: App functionality
- Not sold
- Not used for advertising
- Not used for credit/lending

## Notes
- You must provide a public Privacy Policy URL to publish.
- If you publish this repository with GitHub Pages, you can use:
  - `https://evhanhan.github.io/quick-refund/privacy-policy.html`
- `debugger` and broad host permissions are sensitive and should match your justifications exactly.
