# Changelog

## 3.0.0 (12-Apr-2025)

- **Potentially breaking change**: `excludePatterns` for `LokaliseUpload` now defaults to `[]` (empty array).
- **Potentially breaking change**: `excludePatterns` now accepts `string[]` or `RegExp[]`. Each item must be a valid regular expression string or a `RegExp` object. Patterns are tested against the full absolute path of each file or directory. For example:

```js
excludePatterns: [/locales\\subdir/, /locales\/subdir/, /en\.json$/i],

// or

excludePatterns: ["nested", "backup"],
```

- `fileNamePattern` for `LokaliseUpload` now accepts either regexp-like string or regexp
- Various code tweaks

## 2.1.0 (1-Apr-2025)

- Allow to pass `filenameInferer` to the `uploadTranslations()` function:

```js
const { processes, errors } = await lokaliseUpload.uploadTranslations({
  collectFileParams: {
    inputDirs: ["./locales"],
    extensions: [".json", ".weird_json"],
  },
  uploadFileParams: { replace_modified: true },
  processUploadFileParams: {
    filenameInferer: async (filePath) =>
      path.extname(filePath) === ".weird_json" ? "en.json" : "",
  },
});
```

This function accepts a path to the uploaded file and should return a string to be used as a `filename` on Lokalise. When this function is not provided, returns an empty string, or throws an error, the relative file path is used as the filename.

- Do not expose upload params that are overridden by the package

## 2.0.0 (20-Mar-2025)

- Added new `bundleDownloadTimeout` parameter for the download client. It sets the maximum time (in milliseconds) to wait for the translation bundle download to complete before aborting. The default value is `undefined` (no timeout).

```js
await downloader.downloadTranslations({
  downloadFileParams,
  extractParams,
  processDownloadFileParams: {
    bundleDownloadTimeout: 10000, // Wait up to 10 seconds for the translation bundle to download
  }
);
```

- Update `@lokalise/node-api` to v14

## 1.1.0 (19-Feb-2025)

- Add support for [asyncronous file downloads](https://developers.lokalise.com/reference/download-files-async). The library will automatically check the download process status, wait for completion and extract your translations:

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

- Initial release
