const path = require('path');
const fs = require('fs');

const Command = require('../../core/Command');
const log = require('../../core/logger');
const { registryOption, directoryOption, trackOption } = require('../../core/commandOptions');
const { retrieveFile } = require('../../core/uri-retriever');
const downloadFileAsync = require('../../core/download-file');
const Tracker = require('../../core/tracking/Tracker');
const { provider } = require('../NugetPackageProvider');

class NugetDownloadAllCommand extends Command {
  get definition() {
    return {
      name: 'all',
      description: 'download tarballs for all packages hosted by the registry',
      options: [
        registryOption,
        directoryOption,
        trackOption,
      ],
      action: (command) => this.execute({ ...command }),
    };
  }

  async execute(options = {}) {
    const registry = options.registry || provider.defaultRegistry; // || await getCurrentRegistry();
    const { directory } = options;

    const { track } = options;
    const tracker = track ? new Tracker({ directory }) : null;
    if (track) {
      await tracker.initialize();
    }

    const url = new URL('v3/index.json', registry);
    const searchResults = await retrieveFile(url, { json: true });
    log(['nuget', 'download', 'all'], 'nuget index version', searchResults ? searchResults.version : 'missing');
    const nugetClientVersion = "4.4.0";
    const types = [
      "Catalog/3.0.0",
      "http://schema.emgarten.com/sleet#Catalog/1.0.0",
    ];
    const index = {
      "Catalog/3.0.0": {
        "ClientVersion": "0.0.0",
        "Type": "Catalog/3.0.0",
        "Uri": "https://api.nuget.org/v3/catalog0/index.json",
      },
    };
    const serviceEntry = index[types[0]];
    const serviceEntryUri = serviceEntry.Uri;
    const pages = await retrieveFile(serviceEntryUri, { json: true });
    log(['nuget', 'download', 'all'], 'pages:', pages && pages.count);
    for (const page of pages.items) {
      const pageUrl = page['@id'];
      const pageResults = await retrieveFile(pageUrl, { json: true });
      log(['nuget', 'download', 'all', 'page'], pageUrl, pageResults && pageResults.items && pageResults.items.length);
      pageResults.items.forEach(async (item) => {
        const itemUrl = item['@id'];
        const entryId = item['nuget:id'];
        const entryVersion = item['nuget:version'];
        const normalizedPackageId = entryId.toLowerCase();
        const normalizedVersion = entryVersion.toLowerCase();
        const packageInfo = {
          name: normalizedPackageId,
          version: normalizedVersion,
        };
        const installPath = path.join(directory, normalizedPackageId, normalizedVersion);
        const nupkgExtension = '.nupkg';
        const packageFileName = `${normalizedPackageId}.${normalizedVersion}${nupkgExtension}`;
        const packageFilePath = path.join(installPath, packageFileName);
        if (tracker.contains(packageInfo)) {
          log(['nuget', 'download', 'all', 'skipping'.magenta, 'already tracked'], packageFilePath);
        }
        else if (fs.existsSync(packageFilePath)) {
          if (track) {
            await tracker.track(packageInfo);
          }
          log(['nuget', 'download', 'all', 'skipping'.magenta, 'file exists'], packageFilePath);
        }
        else {
          try {
            log(['nuget', 'download', 'all', 'starting'.cyan, packageFileName], packageFilePath);
            const downloadOptions = {
              directory: installPath,
              filename: packageFileName,
            };
            const { duration } = await downloadFileAsync(itemUrl, downloadOptions);
            if (track) {
              await tracker.track(packageInfo);
            }
            log(['nuget', 'download', 'all', 'finished'.green, packageFileName, `in ${duration}`], packageFilePath);
          }
          catch (error) {
            log(['nuget', 'download', 'all', 'error'.red, packageFileName], packageFilePath, error);
          }
        }
      });
    }
  }
}

module.exports = NugetDownloadAllCommand;