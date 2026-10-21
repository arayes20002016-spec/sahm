# SAHM extension privacy policy

The extension connects Chrome or Edge to the SAHM application on the same Windows computer. SAHM has no developer-operated service for receiving browsing history or downloads, and includes no developer analytics, advertising, or account system.

The extension processes download URLs and the request details needed for capture. It also detects supported media URLs in a tab to show a video download button. Access to HTTP and HTTPS pages supports these functions across websites. Capture is optional, and the popup provides website exclusions. The browser also controls the extension's site permissions. Incognito browsing is disabled.

Session downloads require separate approval in the extension and app. Required session headers, which may include cookies or authorization, are sent to SAHM locally through Native Messaging and held in memory for the task or until the app closes. They may be sent to the original download source to perform the approved download. YouTube downloads do not use these session credentials.

For POST attachments, the browser completes the original response. SAHM then records the completed file at its existing location. The extension does not send the POST body to SAHM for replay. A recovery journal retains up to 128 pending identifiers for up to seven days, with start time and whether session approval is needed. That journal does not store the download URL, file path, or request body. Browser alarms can retry importing a completed file while the browser is running.

Extension preferences are stored in the browser. The desktop app retains download history, including file URLs, names, paths, and state, until the user removes those entries or the app's data. Removing a download entry does not delete its file. Disabling capture stops new automatic handoffs. The extension can be removed in browser settings and its local connection can be unregistered in SAHM.

Publisher: SAHM. Send privacy and support questions through [the SAHM issue tracker](https://github.com/arayes20002016-spec/sahm/issues). Do not post passwords, cookies, or private download URLs in a public issue. This policy applies to version 0.25.0.
