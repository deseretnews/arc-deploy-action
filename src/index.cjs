const core = require('@actions/core')
const github = require('@actions/github')
const { HttpClient } = require('@actions/http-client')

const { getCurrentVersions } = require('./phases/current-versions.cjs')
const { uploadArtifact } = require('./phases/upload.cjs')
const { terminateOldestVersion } = require('./phases/terminate-oldest.cjs')
const { promoteNewVersion } = require('./phases/promote-version.cjs')
const { deployLatestVersion } = require('./phases/deploy-version.cjs')
const { cleanupOldVersions } = require('./phases/clean-versions.cjs')
const {
  verifyMinimumRunningVersions,
  verifyArcHost,
  verifyPageBuilderVersion,
} = require('./validation.cjs')

const runContext = {
  context: github.context,
  orgId: core.getInput('org-id'),
  apiKey: core.getInput('api-key'),
  apiHostname: core.getInput('api-hostname'),
  bundlePrefix: core.getInput('bundle-prefix'),
  bundleName: core.getInput('bundle-name'),
  pagebuilderVersion: core.getInput('pagebuilder-version'),
  artifact: core.getInput('artifact'),
  retryCount: core.getInput('retry-count'),
  retryDelay: core.getInput('retry-delay'),
  minimumRunningVersions: core.getInput('minimum-running-versions'),
  shouldDeploy: ['true', true].includes(core.getInput('deploy')),
  shouldPromote: ['true', true].includes(core.getInput('promote')),
  client: new HttpClient('nodejs - GitHub Actions - arcxp/deploy-action', [], {
    headers: { Authorization: `Bearer ${core.getInput('api-key')}` },
  }),
  forceOverwrite: false,
  core,
}

if (!runContext.bundleName) {
  runContext.bundleName = [
    runContext.bundlePrefix ?? 'bundle',
    new Date().getTime(),
    runContext.context.ref_name,
    runContext.context.sha,
  ].join('-')
} else {
  runContext.forceOverwrite = true
}

if (!runContext.bundlePrefix && !runContext.bundleName) {
  return core.setFailed('You must provide either a bundle prefix or a bundle name.')
}

const retryDelayWait = () =>
  new Promise((res) => setTimeout(() => res(), runContext.retryDelay * 1000))

const main = async () => {
  // A little validation
  verifyMinimumRunningVersions(runContext)
  verifyArcHost(runContext)
  verifyPageBuilderVersion(runContext)

  if (runContext.shouldDeploy === false && runContext.shouldPromote === true) {
    return core.setFailed('If `promote` is true, `deploy` must also be true.')
  }

  const currentVersions = await getCurrentVersions(runContext)
  core.debug('currentVersions', JSON.stringify(currentVersions, undefined, 2))

  let oldestVersion = null;
  let latestVersion = null;

  if (Array.isArray(currentVersions) && currentVersions.length) {
    oldestVersion = currentVersions[0]
    latestVersion = currentVersions[currentVersions.length - 1]
  }

  if (runContext.context.eventName === 'pull_request') {
    core.info('Pull request. will try to clean up old versions')
    const deleteBundle = runContext.context.payload.pull_request.merged === true
    core.info(`Pull request ${deleteBundle ? 'merged' : 'closed without merge'}. Will ${deleteBundle ? '' : 'not '}try to delete bundle.`)
    await cleanupOldVersions(runContext, deleteBundle)
    if (deleteBundle) {
      return core.info('Pull request merged. Bundle cleanup completed. skipping upload, deploy, and promote steps.')
    }
  }

  await uploadArtifact(runContext)

  if (runContext.shouldDeploy) {
    await deployLatestVersion(runContext)

    // Don't terminate if there aren't more versions than one.
    if (oldestVersion && currentVersions && (currentVersions.length > runContext.minimumRunningVersions)) {
      const termResults = terminateOldestVersion(runContext, oldestVersion)
      core.debug(
        'terminateOldestVersionResults',
        JSON.stringify(termResults, undefined, 2),
      )
    }

    if (latestVersion) {
      let retriesRemaining = runContext.retryCount
      let newestVersion = undefined
      // Wait for the internal deployer to do its thing.
      while (retriesRemaining >= 0) {
        const newVersions = await getCurrentVersions(runContext)
        core.debug(`New versions: ${JSON.stringify(newVersions, undefined, 2)}`)
        if (!!newVersions && newVersions[newVersions.length - 1] !== latestVersion) {
          newestVersion = newVersions[newVersions.length - 1]
          break
        }
        await retryDelayWait()
        retriesRemaining -= 1
      }

      // If we didn't identify the new version, that means we timed out. Boo.
      if (!newestVersion) {
        return core.setFailed(
          `We retried ${runContext.retryCount} times with ${runContext.retryDelay} seconds between retries. Unfortunately, the new version does not appear to have deployed successfully. Please check logs, and contact support if this problem continues.\n\nYou may wish to retry this action again, but with debugging enabled.`,
        )
      }

      runContext.newestVersion = newestVersion
      if (runContext.shouldPromote) {
        await promoteNewVersion(runContext)
      }
    }
  }
}

main().finally(() => core.debug('Finished.'))
