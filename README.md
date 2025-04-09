# Lokalise translation file exchange for Node

![npm](https://img.shields.io/npm/v/lokalise-file-exchange)
![CI](https://github.com/bodrovis/lokalise-node-file-exchange/actions/workflows/ci.yml/badge.svg)
[![NPM Downloads][npm-downloads-image]][npm-downloads-url]

This package enables you to easily exchange translation files between your JavaScript/TypeScript project and [Lokalise TMS](https://lokalise.com).

## Prerequisites

Before using this package, ensure you have the following:

- A [Lokalise API token](https://docs.lokalise.com/en/articles/1929556-api-and-sdk-tokens#h_9ea8e7ff3c) with **read/write permissions**.
- An existing [Lokalise project](https://docs.lokalise.com/en/articles/1400460-projects#h_b012f2e31f) of type **"Web and mobile"**.

## Quickstart

### Installation

Install the package via npm:

```bash
npm install --save lokalise-file-exchange
```

### Uploading translation files

Use the `LokaliseUpload` class to upload translation files from your project to Lokalise:

```js
import { LokaliseUpload } from "lokalise-file-exchange";

const apiKey = "YOUR_LOKALISE_API_TOKEN";
const projectId = "YOUR_LOKALISE_PROJECT_ID";

const lokaliseUploader = new LokaliseUpload(
  {
    apiKey,
  },
  {
    projectId,
  },
);

// Upload all files from the `./locales` directory:
const { processes, errors } = await lokaliseUploader.uploadTranslations();

console.log(processes); // Array of QueuedProcess objects
console.log(errors); // Array of errors (if any)
```

### Downloading translation files

Use the `LokaliseDownload` class to download translation files from Lokalise into your project:

```js
import { LokaliseDownload } from "lokalise-file-exchange";
import type { DownloadFileParams } from "@lokalise/node-api";

const apiKey = "YOUR_LOKALISE_API_TOKEN";
const projectId = "YOUR_LOKALISE_PROJECT_ID";

const lokaliseDownloader = new LokaliseDownload(
  {
    apiKey,
  },
  {
    projectId,
  },
);

const downloadFileParams: DownloadFileParams = {
  // Format is mandatory!
  format: "json", // Output format for the downloaded files

  // Other params are optional
  original_filenames: true, // Preserve original filenames from Lokalise
  indentation: "2sp", // Indentation style for the downloaded files
  directory_prefix: "", // Optional prefix for output directory structure
};

// Download all translations into the project root while preserving original filenames
await lokaliseDownloader.downloadTranslations({ downloadFileParams });
```

## Creating and configuring client

The first step is to create an upload or download client. Both clients accept two configuration objects.

```js
import { LokaliseUpload } from "lokalise-file-exchange";
// OR
import { LokaliseDownload } from "lokalise-file-exchange";

const lokaliseUploader = new LokaliseUpload({apiKey}, {projectId});
// OR
const lokaliseDownloader = new LokaliseDownload({apiKey}, {projectId});
```

If you're using [OAuth2 flow](https://lokalise.github.io/node-lokalise-api/additional_info/oauth2_flow), set `useOAuth2` option to `true`:

```js
const lokaliseUploader = new LokaliseUpload({apiKey}, {projectId, useOAuth2: true});
// OR
const lokaliseDownloader = new LokaliseDownload({apiKey}, {projectId, useOAuth2: true});
```

In this case make sure to provide access token for the `apiKey`.

### `ClientParams` configuration

The first object is `ClientParams`, used to instantiate the [`node-lokalise-api` client](https://github.com/lokalise/node-lokalise-api) internally for sending API requests. The only mandatory parameter is `apiKey`, which should contain a string with your Lokalise API token. Other parameters are optional and can be used to:

- [Configure timeouts and API host](https://lokalise.github.io/node-lokalise-api/additional_info/customizing_client)
- Enable compression
- Customize other client options

## `LokaliseExchangeConfig` configuration

The second object, `LokaliseExchangeConfig`, contains additional parameters:

- `projectId` (`string`, required): Your Lokalise project ID. If you're using [project branching](https://docs.lokalise.com/en/articles/3391861-project-branching), provide the branch name after semicolon, for example `"123.abc:my_branch"`.
- `retryParams` (`RetryParams`, optional): Retry parameters for failed API requests. By default, the library performs up to 3 retries for 408 (timeout) and 429 (too many requests) errors. Exponential backoff is applied, with an initial sleep time of 1000 ms. Parameters include:
  - `maxRetries` (`number`): Maximum number of retries. If set to 0, the client will send only a single request without any retries.
  - `initialSleepTime` (`number`): The initial value for the sleep time in milliseconds. Subsequent sleep times are calculated using the formula `initialSleepTime * 2 ** (attempt - 1)`, where `attempt > 0`.

## Performing translation file downloads

To download translation files from Lokalise into your project, use the `downloadTranslations()` method on the client.

```js
await lokaliseDownloader.downloadTranslations({ downloadFileParams, extractParams, processDownloadFileParams });
```

`downloadTranslations()` accepts a single object, `DownloadTranslationParams`, with three attributes.

### DownloadFileParams

The `DownloadFileParams` attribute contains all download parameters passed directly to the [`download()` function](https://lokalise.github.io/node-lokalise-api/api/files#download-translation-file). For details about supported parameters, refer to the [DownloadFiles endpoint documentation](https://developers.lokalise.com/reference/download-files).

**Required parameter:**

- `format` (`string`): Specifies the download format (e.g., `json`, `xml`, etc.).

### ExtractParams

After downloading the translation bundle, the client extracts it automatically. You can control the extraction process with the following parameter:

- `outputDir` (`string`, optional): Specifies the directory where the archive is extracted. The default value is `"./"` (project root).

### ProcessDownloadFileParams

By default, all downloads are performed synchronously. However, for larger projects it might be beneficial to use asynchronous downloading. To achieve that, configure `processDownloadFileParams` that accepts:

- `asyncDownload` (`boolean`): Enable or disable asynchronous downloads. The default value is `false`.
- `pollInitialWaitTime` (`number`): Initial wait time (in milliseconds) before polling download statuses.
- `pollMaximumWaitTime` (`number`): Maximum wait time (in milliseconds) for polling.
- `bundleDownloadTimeout` (`number`): Maximum time (in milliseconds) to wait for the translation bundle download to complete before aborting. The default value is `undefined` (no timeout).

When asynchronous download is enabled, library will try to poll for the download process status. Once the bundle is available, your translations will be automatically extracted.

## Recommendations for downloading

To preserve original filenames assigned to translation keys during the download, use configurations that align with your project structure. For example:

- If your translations are located in a `./locales` directory
- Keys have filenames assigned in the format `locales/%LANG_ISO%.json` or `locales/some_nested_dir/%LANG_ISO%.json`

```js
import type { DownloadFileParams } from "@lokalise/node-api";
import type { ExtractParams } from "lokalise-file-exchange";

const downloadFileParams: DownloadFileParams = {
  format: "json",
  original_filenames: true,
  directory_prefix: "",
};

try {
  await lokaliseDownloader.downloadTranslations({ downloadFileParams });
} catch (err) {
  console.error(err);
}
```

You can configure your download to maintain this structure by specifying `original_filenames` and `directory_prefix`.

## Performing translation file uploads

To upload translation files from Lokalise into your project, use the `uploadTranslations()` method.

```js
const { processes, errors } = await lokaliseUploader.uploadTranslations({ uploadFileParams, collectFileParams, processUploadFileParams });
```

File uploading happens in the background so this method will return an array of [QueuedProcesses](https://developers.lokalise.com/reference/queued-process-object) and an array of errors that happened during uploading.

This method accepts an optional `UploadTranslationParams` object for further customization. It consists of three main attributes.

### UploadFileParams

This attribute contains parameters passed to the [`upload()` function](https://lokalise.github.io/node-lokalise-api/api/files#upload-translation-file). For details, refer to the [UploadFile endpoint documentation](https://developers.lokalise.com/reference/upload-a-file).

The client automatically provides the following required parameters:

- `data`
- `filename`
- `lang_iso`

You do not need to set these manually.

### CollectFileParams

This attribute determines which files are included or excluded from the upload. All parameters are optional.

- `inputDirs` (`string[]`): Directories to upload translations from. Default: `["./locales"]`.
- `extensions` (`string[]`): File extensions to include. Default: `[".*"]` (all extensions). For example, set to `[".json", ".xml"]` to include only JSON and XML files.
- `excludePatterns` (`string[] | RegExp[]`): Patterns to exclude. Each item must be a valid regular expression string or a `RegExp` object. Patterns are tested against the full absolute path of each file or directory.
- `recursive` (`boolean`): Whether to include files from nested directories. Default: `true`.
- `fileNamePattern` (`string | RegExp`): Pattern for filenames to upload. Default: `*` (all files). For example, set to `"^en.*"` to upload files starting with "en.".

### ProcessUploadFileParams

This attribute provides advanced configuration for the upload process.

- `languageInferer`: A function to infer the language ISO code for uploaded files.
- `filenameInferer`: A function to infer the filename for uploaded files.
- `pollStatuses` (`boolean`): Whether to wait for Lokalise to process the uploaded files. Default: `false`.
- `pollInitialWaitTime` (`number`): Initial wait time (in milliseconds) before polling upload statuses.
- `pollMaximumWaitTime` (`number`): Maximum wait time (in milliseconds) for polling.

#### Inferring language ISO code

Lokalise requires a `lang_iso` parameter for every file. By default, the client infers this from the filename (e.g., `en.json` > `lang_iso: "en"`, `fr_FR.xml` > `lang_iso: "fr_FR"`). If the project lacks the corresponding language, the upload fails.

For custom logic, use the `languageInferer` function, which has the signature:  
`(filePath: string) => Promise<string> | string`. If this function fails or returns an empty string, the filename is used as a language ISO code.

**Example: Inferring from file content**

Suppose the file's first key contains the language code:

```json
{
  "en": {
    "key": "translation value"
  }
}
```

You can infer the language with:

```js
const { processes, errors } = await lokaliseUpload.uploadTranslations({
  processUploadFileParams: {
    languageInferer: async (filePath) => {
      // Provide any conditions as needed
      if (path.extname(filePath) === ".json") {
        const fileData = await fs.promises.readFile(filePath);
        const jsonContent = JSON.parse(fileData.toString());
        return Object.keys(jsonContent)[0];
      }
      return "";
    },
  },
});
```

**Example: Inferring from parent folder**

If translation files are stored in language-named folders (`/locales/en/main.json`), use:

```js
const { processes, errors } = await lokaliseUploader.uploadTranslations({
  processUploadFileParams: {
    languageInferer: (filePath) => {
      try {
        const parentDir = path.dirname(filePath);
        return path.basename(parentDir);
      } catch (_error) {
        return "";
      }
    },
  }
});
```

#### Inferring filename

Lokalise requires a `filename` parameter for every file. By default, the client infers this from the file path relative to the project root.

For custom logic, use the `filenameInferer` function, which has the signature:  
`(filePath: string) => Promise<string> | string`.

#### Polling for upload statuses

All translation files are uploaded to Lokalise in the background, which is why the `uploadTranslations()` method returns an array of `processes` containing `QueuedProcess[]` objects. By default, the client does not wait for Lokalise to complete the upload process or report the success or failure of each file.

To ensure the client waits until all files are fully processed by Lokalise, you can set the `pollStatuses` option to `true`. This enables the client to poll the status of each file until it is marked as completed, cancelled, or failed. Additionally, you can fine-tune the polling behavior by configuring the `pollInitialWaitTime` (initial wait time before polling starts) and `pollMaximumWaitTime` (maximum duration to wait for all uploads to be processed).

```js
const { processes, errors } = await lokaliseUploader.uploadTranslations({
  processUploadFileParams: {
    pollStatuses: true,
    pollInitialWaitTime: 2e3,
    pollMaximumWaitTime: 150e3,
  }
});
```

Now the function will wait up to 150 seconds for all processes to be completed (or marked as cancelled or failed).

## Samples

Find the sample usage at [github.com/bodrovis/lokalise-node-file-exchange-samples](https://github.com/bodrovis/lokalise-node-file-exchange-samples).

## License

Licensed under BSD 3 Clause

(c) [Ilya Krukowski](https://bodrovis.tech/)

[npm-downloads-image]: https://badgen.net/npm/dm/lokalise-file-exchange
[npm-downloads-url]: https://npmcharts.com/compare/lokalise-file-exchange?minimal=true
