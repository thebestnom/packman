import semver from 'semver';
import util from 'util';
import { URL } from 'url';

import { Logger, LoggerOptions } from '../../core/logger';
import { fetch } from '../../core/fetcher';
import NpmPackageProvider from './NpmPackageProvider';
import { DependenciesOptions } from './npm-options';

const provider = new NpmPackageProvider();
const { defaultRegistry, maxRetries, requestTimeout } = provider;

let cacheHits = 1;
let registryHits = 1;

const packagesCache = new Map();
const tarballs = new Set<string>();

type CommonCrawlOptions =
  LoggerOptions
  & {
    registry?: string
  }

type GetDependenciesOptions = LoggerOptions & DependenciesOptions & {
  name: string
  version?: string
  outputPrefix?: string
  registry?: string
}

export async function getDependencies(options: GetDependenciesOptions): Promise<Set<string>> {
  const packageJson = await _retrievePackageVersion(options);
  if (!packageJson) {
    const { name, version, registry, logger } = options;
    logger.error('ERROR'.red, 'failed to retrieve version of package', name, version, 'from registry', registry || '<current>');
    return new Set();
  }

  if (tarballs.has(packageJson.dist.tarball)) {
    return tarballs;
  }

  tarballs.add(packageJson.dist.tarball);

  return await getPackageJsonDependencies({ ...options, packageJson });
}

type GetPackageJsonDependenciesOptions =
  CommonCrawlOptions
  & DependenciesOptions
  & {
    packageJson: NpmPackageManifest
  }

export async function getPackageJsonDependencies(options: GetPackageJsonDependenciesOptions) {
  await getSelectedDependencies(options);

  return tarballs;
}

async function getSelectedDependencies(options: GetPackageJsonDependenciesOptions) {
  const {
    dependencies = true,
    devDependencies = false,
    peerDependencies = false,

    packageJson,
    registry,
    logger,
  } = options;

  const { name = '<unknown>' } = packageJson;
  const messageFormat = `getting ${'%s'.magenta} for ${name.yellow}`;

  if (dependencies) {
    logger.info(messageFormat, 'dependencies');
    await _getDependenciesFrom(packageJson.dependencies, 'dependency '.magenta, registry, logger);
  }

  if (devDependencies) {
    logger.info(messageFormat, 'devDependencies');
    await _getDependenciesFrom(packageJson.devDependencies, 'devDependency '.magenta, registry, logger);
  }

  if (peerDependencies) {
    logger.info(messageFormat, 'peerDependencies');
    await _getDependenciesFrom(packageJson.peerDependencies, 'peerDependency '.magenta, registry, logger);
  }
}

type RetrievePackageVersionOptions = LoggerOptions & {
  name: string
  version?: string
  outputPrefix?: string
  registry?: string
}

async function _retrievePackageVersion(options: RetrievePackageVersionOptions) {
  const { name, version, outputPrefix = '', registry = defaultRegistry, logger } = options;
  const uri = new URL(name.replace('/', '%2F'), registry).href;

  const retrievingMessage = `retrieving ${outputPrefix}${name.cyan} ${(version || '').cyan}`;

  if (packagesCache.has(name)) {
    logger.info('cache'.yellow, cacheHits, retrievingMessage);
    cacheHits++;
    const allPackageVersionsDetails = packagesCache.get(name);
    const maxSatisfyingVersion = _getMaxSatisfyingVersion(allPackageVersionsDetails, version);
    return allPackageVersionsDetails.versions[maxSatisfyingVersion];
  }

  logger.info('registry'.blue, registryHits, retrievingMessage);
  registryHits++;
  const allPackageVersionsDetails = await _retryGetRequest(uri, maxRetries, logger);
  if (allPackageVersionsDetails) {
    packagesCache.set(name, allPackageVersionsDetails);
    const maxSatisfyingVersion = _getMaxSatisfyingVersion(allPackageVersionsDetails, version);
    return allPackageVersionsDetails.versions[maxSatisfyingVersion];
  }
  else {
    return null;
  }
}

type NamedObject = {
  name: string
}

type PackageObject = NamedObject & {
  // name: string
  version: string
  devDependencies: boolean
  peerDependencies: boolean
  outputPrefix: string
  registry: string
}

export type SearchResults = {
  [name: string]: PackageObject
}

type GetDependenciesFromSearchResultsOptions = LoggerOptions & {
  registry: string
  filters?: [(currentPackage: string) => boolean]
}

type DependenciesObject = {
  [name: string]: string
}

export async function getDependenciesFromSearchResults(searchResults: SearchResults, options: GetDependenciesFromSearchResultsOptions): Promise<Set<string>> {
  const {
    registry,
    logger,
    filters = [],
  } = options;

  const allFilters = [
    (currentPackage: any) => currentPackage instanceof Object,
    ...filters,
  ];
  const compositeFilter = currentPackage => allFilters.every(filter => filter(currentPackage));

  const packages = Object.values(searchResults)
    .filter((currentPackage: any) => compositeFilter(currentPackage));

  const dependenciesObject = packages.reduce<DependenciesObject>((memo: DependenciesObject, current: NamedObject) => {
    const version = _getMaxSatisfyingVersion(current);
    memo[current.name] = version;
    return memo;
  }, {});

  await _getDependenciesFrom(dependenciesObject, '', registry, logger);

  return tarballs;
}

async function _getDependenciesFrom(dependenciesObject: DependenciesObject, outputPrefix: string, registry = defaultRegistry, logger: Logger) {
  const dependencies = Object.keys(dependenciesObject || {});
  await Promise.all(dependencies.map(dependency => getDependencies({
    name: dependency,
    version: dependenciesObject[dependency],
    outputPrefix,
    registry,
    logger,
  })));
}

function _getMaxSatisfyingVersion(allPackageVersionsDetails: any, version?: string) {
  if (util.isNullOrUndefined(version)) {
    return allPackageVersionsDetails['dist-tags'].latest;
  }
  const versions = Object.keys(allPackageVersionsDetails.versions);
  return semver.maxSatisfying(versions, version);
}

async function _retryGetRequest(uri: string, count: number, logger: Logger): Promise<any> {
  try {
    const { body } = await fetch<any>({
      uri,
      responseType: 'json',
      timeout: requestTimeout,
      logger,
    });
    if (count < maxRetries) {
      logger.info(`download success:`.green, uri, count);
    }
    return body;
  } catch (error) {
    const message = (error.cause && error.cause.code) || error.message;
    logger.error(`download failure: ${message}`.red, uri, count);
    if (count > 0) {
      return _retryGetRequest(uri, count - 1, logger);
    }
    if (error.response && error.response.statusCode === 404) {
      return null;
    }
    throw error;
  }
}
