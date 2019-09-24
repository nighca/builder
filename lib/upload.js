/*
 * @file upload files
 * @author nighca <nighca@live.cn>
 */

const path = require('path')
const walk = require('walk')
const qiniu = require('qiniu')

const paths = require('./utils/paths')
const logger = require('./utils/logger')
const logLifecycle = require('./utils').logLifecycle
const getPathFromUrl = require('./utils').getPathFromUrl
const findBuildConfig = require('./utils/build-conf').find

const sourceMapPattern = require('./webpack-config/addons/sourcemap').pattern

const getAllFiles = (baseDir) => {
  return new Promise((resolve, reject) => {
    const walker = walk.walk(baseDir)
    const files = []

    walker.on('error', (root, stat, next) => {
      reject(stat.error)
    })

    walker.on('files', (root, stats, next) => {
      stats.forEach(
        stat => files.push(
          path.relative(baseDir, path.join(root, stat.name))
        )
      )
      next()
    })
    walker.on('end', () => {
      resolve(files)
    })
  })
}

const uploadFile = (localFile, bucket, key, mac) => new Promise(
  (resolve, reject) => {
    const options = {
      scope: bucket + ':' + key
    }
    const putPolicy = new qiniu.rs.PutPolicy(options)
    const uploadToken = putPolicy.uploadToken(mac)
    const putExtra = new qiniu.form_up.PutExtra()

    // jenkins 环境会出现请求 uc.qbox.me 不通的情况，暂时无法定位
    // 网络正常：curl 可以正常请求，而通过 qiniu nodejs sdk 则无法正常请求
    // 参考 https://jenkins.qiniu.io/view/fusion/view/Team/job/fusion-admin-frontend-build/216/console
    // 这里通过手工配置上传 host，避免对 uc.qbox.me 的访问
    // 对应发布特别的供该 jenkins 项目使用的镜像：aslan-spock-register.qiniu.io/fec-builder-dev:2019.09.24.13.09
    const config = new qiniu.conf.Config({
      zoneExpire: -1,
      useCdnDomain: false,
      zone: new qiniu.conf.Zone(
        ['up.qiniup.com'],
        []
      )
    })

    const formUploader = new qiniu.form_up.FormUploader(config)

    formUploader.putFile(uploadToken, key, localFile, putExtra, (err, ret) => {
      if(err) {
        reject(err)
        return
      }
      resolve(ret)
    })
  }
)

const upload = () => findBuildConfig().then(
  buildConfig => {
    const deployConfig = buildConfig.deploy.config
    const distPath = paths.getDistPath(buildConfig)
    const prefix = getPathFromUrl(buildConfig.publicUrl, false)

    const mac = new qiniu.auth.digest.Mac(deployConfig.accessKey, deployConfig.secretKey)

    return Promise.all([
      distPath,
      deployConfig,
      prefix,
      mac,
      getAllFiles(distPath)
    ])
  }
).then(
  ([distPath, deployConfig, prefix, mac, files]) => Promise.all(
    files.map(name => {
      const key = prefix ? `${prefix}/${name}` : name
      const filePath = path.resolve(distPath, name)

      // 排除 sourcemap 文件，不要上传到生产环境 CDN
      if (sourceMapPattern.test(filePath)) {
        return logger.info(`[IGNORE] ${filePath}`)
      }

      return uploadFile(
        filePath,
        deployConfig.bucket,
        key,
        mac
      ).then(
        () => logger.info(`[UPLOAD] ${filePath} -> ${key}`)
      )
    })
  )
)

module.exports = logLifecycle('upload', upload, logger)
