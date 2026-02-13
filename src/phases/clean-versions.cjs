const cleanupOldVersions = async ({ core, client, apiHostname, bundleName }, deleteBundle = false) => {
  try {
    // Fetch full service list to get bundle names and aliases
    const response = await client.get(`https://${apiHostname}/deployments/fusion/services`)
    const { lambdas } = JSON.parse(await response.readBody())

    // Find the deployment running this bundle
    const deployedVersion = lambdas.find(
      (service) => service.Environment.Variables.BUNDLE_NAME === bundleName
    )

    if (!deployedVersion) {
      core.info(`No running deployment found for bundle "${bundleName}". Skipping terminate.`)
    } else {
      // Don't terminate if it's the live version
      const isLive = deployedVersion.Aliases.some((alias) => alias.Name === 'live')
      if (isLive) {
        core.info(`Bundle "${bundleName}" is the live deployment (version ${deployedVersion.Version}). Skipping terminate.`)
      } else {
        core.info(`Terminating deployment version ${deployedVersion.Version} for bundle "${bundleName}"`)
        try {
          await client.post(`https://${apiHostname}/deployments/fusion/services/${deployedVersion.Version}/terminate`)
        } catch (err) {
          core.warning(`Failed to terminate version ${deployedVersion.Version}: ${err.message}`)
        }
      }
    }

    if (deleteBundle) {
      // Delete the bundle
      core.info(`Deleting bundle "${bundleName}"`)
      try {
        await client.post(`https://${apiHostname}/deployments/fusion/bundles/${encodeURI(bundleName)}/delete`)
      } catch (err) {
        core.warning(`Failed to delete bundle "${bundleName}": ${err.message}`)
      }
    }
  } catch (error) {
    core.setFailed(`Cleanup failed: ${error.message}`)
  }
}

module.exports = { cleanupOldVersions }