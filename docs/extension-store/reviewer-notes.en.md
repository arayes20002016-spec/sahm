# Certification notes — Edge submission draft

SAHM is a companion to a Windows x64 desktop download manager. Test with the installer matching the extension version. Source and support are available at https://github.com/arayes20002016-spec/sahm. The privacy page is https://arayes20002016-spec.github.io/sahm/privacy.html. The trial download is published under the v0.25.0 release. Check that these pages and the installer are accessible before submitting.

After installing the desktop app, open Browser integration and register the local connection. For a store build, the app must include the actual Edge extension ID in browser/store-release.json so the native host explicitly allows that origin. The development ID differs from the store ID. Do not use a production installer that only trusts the development ID for certification.

Start SAHM, install the extension from the submitted store item, and open its popup. Connection should be reported independently of capture. Capture starts disabled; opt into it in both products. Session and POST settings are separate. Use a public test server you control with a downloadable GET response and an attachment POST response. Verify one server POST, browser completion, and a completed SAHM entry in the original file location. Stop SAHM and verify the browser keeps its download.

Use only media you own or are licensed to save for the video-button test. YouTube support is present in the submitted source; disclose this functionality during review. Do not submit this same package to Chrome Web Store without addressing Google's published YouTube-download policy. Nothing in the package hides features from reviewers or changes them remotely.

## Permissions

| Permission | Purpose |
| --- | --- |
| downloads | Observe download state, hand off eligible GET requests only after SAHM acknowledges them, and import completed browser POST attachments. |
| nativeMessaging | Exchange local requests with com.sahm.downloader. The desktop app is required. |
| storage | Store opt-in settings, exclusions, and bounded pending completed-POST identifiers. Popup drafts use session storage. |
| contextMenus | Provide the user-triggered Send link to SAHM action. |
| webRequest | Observe request methods, attachment responses, media resources, and session headers required for opted-in capture. It does not intercept unrelated content for analytics. |
| alarms | Recover pending completed-POST imports while the browser is running. At most 128 identifiers are retained for up to 7 days, without storing request bodies or URLs in this recovery journal. |
| http://*/* and https://*/* | Show the video button and observe eligible downloads across user-selected websites. The popup provides exclusions; the browser can restrict site access. |

The extension contains its executable JavaScript locally. It does not fetch or evaluate remotely hosted extension code. SAHM's desktop media runtime is separate from the extension and must be disclosed as a desktop dependency. Native Messaging stays on the same computer; the app accesses the download's source website. There is no developer-operated collection endpoint, telemetry, advertising, payment flow, or incognito support.

The native host registration uses the current Windows user and exact trusted extension origins. Store pages are opened in the chosen browser with user consent. No enterprise browser policy or forced extension installation is used.
