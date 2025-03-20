# Changelog

## 2.0.0 (20-Mar-2025)

* Added new `bundleDownloadTimeout` parameter for the download client. It sets the maximum time (in milliseconds) to wait for the translation bundle download to complete before aborting. The default value is `undefined` (no timeout).

```js
await downloader.downloadTranslations({
  downloadFileParams,
  extractParams,
  processDownloadFileParams: {
    bundleDownloadTimeout: 10000, // Wait up to 10 seconds for the translation bundle to download
  }
);
```

* Update `@lokalise/node-api` to v14

## 1.1.0 (19-Feb-2025)

* Add support for [asyncronous file downloads](https://developers.lokalise.com/reference/download-files-async). The library will automatically check the download process status, wait for completion and extract your translations:

```js
downloader = new LokaliseDownload({ apiKey }, { projectId });

downloader.downloadTranslations({
  { format: "json" },
  { outputDir: "/output/dir" },
  processDownloadFileParams: {
    asyncDownload: true, // Download in background
    pollInitialWaitTime: 1000, // Initial wait time before checking background process status
    pollMaximumWaitTime: 10000, // Maxiumum wait time before exiting with timeout
  },
});
```

By default all downloads are synchronous and it's not recommended to enable this feature for smaller projects.

## 1.0.0 (16-Dec-2024)

* Initial release