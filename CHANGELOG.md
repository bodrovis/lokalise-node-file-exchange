# Changelog

## 2.0.0

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