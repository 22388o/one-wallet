import React, { useEffect, useState, useRef, useCallback } from 'react'
import Button from 'antd/es/button'
import Space from 'antd/es/space'
import Typography from 'antd/es/typography'
import Col from 'antd/es/col'
import message from '../../message'
import { Hint, Warning } from '../../components/Text'
import { AverageRow, TallRow } from '../../components/Grid'
import { CommitRevealProgress } from '../../components/CommitRevealProgress'
import AnimatedSection from '../../components/AnimatedSection'
import util, { autoWalletNameHint, generateOtpSeed } from '../../util'
import ShowUtils from './show-util'
import { useSelector } from 'react-redux'
import { EOTPDerivation, SmartFlows } from '../../../../lib/api/flow'
import ONE from '../../../../lib/onewallet'
import ONEUtil from '../../../../lib/util'
import { api } from '../../../../lib/api'
import ONEConstants from '../../../../lib/constants'
import { OtpStack } from '../../components/OtpStack'
import { useOpsCombo } from '../../components/Common'
import QrCodeScanner from '../../components/QrCodeScanner'
import ScanGASteps from '../../components/ScanGASteps'
import {
  buildQRCodeComponent,
  getQRCodeUri, getSecondCodeName,
  OTPUriMode, parseAuthAccountName,
  parseMigrationPayload,
  parseOAuthOTP
} from '../../components/OtpTools'
import * as Sentry from '@sentry/browser'
import storage from '../../storage'
import walletActions from '../../state/modules/wallet/actions'
import Paths from '../../constants/paths'
import WalletConstants from '../../constants/wallet'
import WalletCreateProgress from '../../components/WalletCreateProgress'
import qrcode from 'qrcode'
import { OtpSetup, TwoCodeOption } from '../../components/OtpSetup'
import WalletAddress from '../../components/WalletAddress'
import { useHistory } from 'react-router'
import Divider from 'antd/es/divider'
import humanizeDuration from 'humanize-duration'
import { OtpSuperStack } from '../../components/OtpSuperStack'
import ONENames from '../../../../lib/names'
const { Title, Text } = Typography

const Subsections = {
  init: 'init', // choose method,
  scan: 'scan', // scan an exported QR code from authenticator
  new: 'new', // use a new authenticator code
  confirm: 'confirm' // authorize with old authenticator code, confirm, finalize; show progress circle
}

const Extend = ({
  address,
  onClose: onCloseOuter,
}) => {
  const history = useHistory()
  const {
    dispatch, wallet, network, stage, setStage, resetOtps,
    resetWorker, recoverRandomness, otpState, otpStates, isMobile, os
  } = useOpsCombo({ address })

  const moreAuthRequired = !!(wallet?.innerRoots?.length)

  const dev = useSelector(state => state.global.dev)
  const { majorVersion, name, expert } = wallet
  const [method, setMethod] = useState()
  const [seed, setSeed] = useState()
  const [seed2, setSeed2] = useState()
  const [identificationKey, setIdentificationKey] = useState()

  const [section, setSection] = useState(Subsections.init)

  const [root, setRoot] = useState() // Uint8Array
  const [effectiveTime, setEffectiveTime] = useState(Math.floor(Date.now() / WalletConstants.interval6) * WalletConstants.interval6)
  const [hseed, setHseed] = useState()
  const [layers, setLayers] = useState()
  const [innerTrees, setInnerTrees] = useState([])

  const [doubleOtp, setDoubleOtp] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressStage, setProgressStage] = useState(0)
  const securityParameters = ONEUtil.securityParameters(wallet)
  // eslint-disable-next-line no-unused-vars
  const [computeInProgress, setComputeInProgress] = useState(false)

  const [confirmName, setConfirmName] = useState()

  const [qrCodeData, setQRCodeData] = useState()
  const [secondOtpQrCodeData, setSecondOtpQrCodeData] = useState()

  const [validationOtp, setValidationOtp] = useState()
  const validationOtpRef = useRef()
  const [showSecondCode, setShowSecondCode] = useState()
  const duration = WalletConstants.defaultDuration
  const slotSize = wallet.slotSize

  const reset = () => {
    setHseed(null)
    setRoot(null)
    setLayers(null)
    setInnerTrees([])
    setEffectiveTime(0)
    setProgressStage(0)
    setProgress(0)
  }
  const onClose = () => {
    reset()
    setSection(Subsections.init)
    setSeed(null)
    setSeed2(null)
    setQRCodeData(null)
    setShowSecondCode(null)
    setSecondOtpQrCodeData(null)
    setConfirmName(null)
    setValidationOtp(null)
    setDoubleOtp(false)
    setMethod(null)
    onCloseOuter()
  }

  useEffect(() => {
    if (!seed) {
      setIdentificationKey(null)
      return
    }
    setIdentificationKey(ONEUtil.getIdentificationKey(seed, true))
  })
  useEffect(() => {
    if (!seed || method !== 'new') {
      return
    }
    const f = async function () {
      const oneAddress = util.safeOneAddress(wallet?.address)
      const otpDisplayName = `${ONENames.nameWithTime(name, effectiveTime)} [${oneAddress}]`
      const otpUri = getQRCodeUri(seed, otpDisplayName, OTPUriMode.MIGRATION)
      const otpQrCodeData = await qrcode.toDataURL(otpUri, { errorCorrectionLevel: 'low', width: isMobile ? 192 : 256 })
      setQRCodeData(otpQrCodeData)
    }
    f()
  }, [name, method, seed])
  useEffect(() => {
    if (!doubleOtp || !seed2 || method !== 'new') {
      return
    }
    const f = async function () {
      const oneAddress = util.safeOneAddress(wallet?.address)
      const otpDisplayName2 = `${ONENames.nameWithTime(getSecondCodeName(name), effectiveTime)} [${oneAddress}]`
      const secondOtpUri = getQRCodeUri(seed2, otpDisplayName2, OTPUriMode.MIGRATION)
      const secondOtpQrCodeData = await qrcode.toDataURL(secondOtpUri, { errorCorrectionLevel: 'low', width: isMobile ? 192 : 256 })
      setSecondOtpQrCodeData(secondOtpQrCodeData)
    }
    f()
  }, [name, method, seed2, doubleOtp])

  const { prepareValidation, ...handlers } = ShowUtils.buildHelpers({
    setStage,
    otpState,
    network,
    resetOtp: moreAuthRequired ? resetOtps : otpState.resetOtp,
    resetWorker,
    onSuccess: async () => {
      const rootHexView = ONEUtil.hexView(root)
      const promises = [storage.setItem(rootHexView, layers)]
      for (const { layers: innerLayers, root: innerRoot } of innerTrees) {
        promises.push(storage.setItem(ONEUtil.hexView(innerRoot), innerLayers))
      }
      await Promise.all(promises)
      // TODO: validate tx receipt log events and remove old root/layers from storage
      const newWallet = {
        _merge: true,
        address,
        root: rootHexView,
        duration,
        effectiveTime,
        hseed: ONEUtil.hexView(hseed),
        doubleOtp,
        network,
        acknowledgedNewRoot: rootHexView,
        identificationKeys: [identificationKey],
        localIdentificationKey: identificationKey,
        innerRoots: innerTrees.map(({ root }) => ONEUtil.hexView(root)),
        ...securityParameters,
      }
      dispatch(walletActions.updateWallet(newWallet))
      message.success(`Wallet ${wallet.name} (${address}) expiry date is renewed to ${new Date(effectiveTime + duration).toLocaleDateString()}`)
      setTimeout(() => history.push(Paths.showAddress(address)), 1500)
    }
  })

  const doReplace = async () => {
    if (stage >= 0) {
      return
    }
    const { otp, otp2, invalidOtp2, invalidOtp } = prepareValidation({
      state: { ...otpState }, checkAmount: false, checkDest: false, checkOtp: !moreAuthRequired
    }) || {}

    if (!moreAuthRequired) {
      if (invalidOtp || invalidOtp2) return
    }

    if (!root || !innerTrees?.length || !identificationKey) {
      console.error('Root is not set')
      return
    }

    const newInnerCores = ONEUtil.makeInnerCores({ innerTrees, effectiveTime, duration, slotSize, interval: WalletConstants.interval })
    const newCore = ONEUtil.makeCore({ effectiveTime, duration, interval: WalletConstants.interval, height: layers.length, slotSize, root })
    console.log({ newCore, newInnerCores, identificationKey })
    const encodedData = ONEUtil.abi.encodeParameters(['tuple(bytes32,uint8,uint8,uint32,uint32,uint8)', 'tuple[](bytes32,uint8,uint8,uint32,uint32,uint8)', 'bytes'], [newCore, newInnerCores, identificationKey])
    const args = { ...ONEConstants.NullOperationParams, data: encodedData, operationType: ONEConstants.OperationType.DISPLACE }

    SmartFlows.commitReveal({
      wallet,
      ...(moreAuthRequired
        ? {
            deriver: EOTPDerivation.deriveSuperEOTP,
            otp: otpStates.map(({ otpInput }) => parseInt(otpInput)),
          }
        : {
            otp,
            otp2,
            recoverRandomness,
          }),
      commitHashGenerator: ONE.computeDataHash,
      commitHashArgs: { ...args, data: ONEUtil.hexStringToBytes(encodedData) },
      revealAPI: api.relayer.reveal,
      revealArgs: { ...args, data: encodedData },
      ...handlers,
    })
  }

  useEffect(() => {
    if (validationOtp?.length !== 6) {
      return
    }
    const currentSeed = showSecondCode ? seed2 : seed
    const expected = ONEUtil.genOTP({ seed: currentSeed })
    const code = new DataView(expected.buffer).getUint32(0, false).toString()
    setValidationOtp('')
    if (code.padStart(6, '0') !== validationOtp.padStart(6, '0')) {
      message.error('Code is incorrect. Please try again.')
      validationOtpRef?.current?.focusInput(0)
    } else if (doubleOtp && !showSecondCode) {
      setShowSecondCode(true)
      validationOtpRef?.current?.focusInput(0)
    } else {
      setSection(Subsections.confirm)
    }
  }, [validationOtp])

  useEffect(() => {
    if (!seed) {
      return
    }
    const worker = new Worker('/ONEWalletWorker.js')
    const salt = ONEUtil.hexView(generateOtpSeed())
    worker.onmessage = (event) => {
      const { status, current, total, stage, result, salt: workerSalt } = event.data
      if (workerSalt && workerSalt !== salt) {
        // console.log(`[Extend] Discarding outdated worker result (salt=${workerSalt}, expected=${salt})`)
        return
      }
      if (status === 'working') {
        setProgress(Math.round(current / total * 100))
        setProgressStage(stage)
      }
      if (status === 'done') {
        const { hseed, root, layers, innerTrees, doubleOtp } = result
        setHseed(hseed)
        setRoot(root)
        setLayers(layers)
        setDoubleOtp(doubleOtp)
        setInnerTrees(innerTrees)
        setComputeInProgress(false)
      }
    }
    console.log('[Extend] Posting to worker')
    worker && worker.postMessage({
      seed,
      salt,
      seed2: doubleOtp && seed2,
      effectiveTime,
      duration,
      slotSize,
      interval: WalletConstants.interval,
      ...securityParameters
    })
    setComputeInProgress(true)
    return () => {
      worker.terminate()
    }
  }, [seed, method, doubleOtp])

  useEffect(() => {
    reset()
    if (method === 'new') {
      setSeed(generateOtpSeed())
      setSeed2(generateOtpSeed())
      setSection(Subsections.new)
      setEffectiveTime(Math.floor(Date.now() / WalletConstants.interval6) * WalletConstants.interval6)
    } else if (method === 'scan') {
      setSeed(null)
      setSeed2(null)
      setSection(Subsections.scan)
    }
  }, [method])

  const onScan = (e) => {
    if (e && !seed) {
      try {
        let parsed
        if (e.startsWith('otpauth://totp')) {
          parsed = parseOAuthOTP(e)
        } else {
          parsed = parseMigrationPayload(e)
        }

        if (!parsed) {
          return
        }
        message.debug(`Scanned: ${JSON.stringify(parsed)}`)
        const { secret2, secret, name: rawName } = parsed
        const bundle = parseAuthAccountName(rawName)
        if (!bundle) {
          message.error('Bad authenticator account name. Expecting name, followed by time and address (optional)')
          return
        }
        const { name, address: oneAddress } = bundle
        const inferredAddress = util.safeNormalizedAddress(oneAddress)
        if (inferredAddress !== address && wallet?.backlinks?.includes(inferredAddress)) {
          message.error('Address of scanned account does not match this wallet, and is not an address this wallet upgraded from')
          return
        }
        setSeed(secret)
        if (secret2) {
          setSeed2(secret2)
          setDoubleOtp(true)
        }
        if (name !== wallet.name) {
          setConfirmName(name)
          return
        }
        setSection(Subsections.confirm)
      } catch (ex) {
        Sentry.captureException(ex)
        console.error(ex)
        message.error(`Failed to parse QR code. Error: ${ex.toString()}`)
      }
    }
  }
  const confirmUseName = () => {
    setSection(Subsections.confirm)
  }
  const cancelUseName = () => {
    setConfirmName(null)
    setSeed(null)
    setSeed2(null)
  }

  const Subsection = useCallback(({ children }) => {
    return (
      <AnimatedSection title={
        <Space direction='vertical'>
          <Title level={3}>Renew Wallet</Title>
          <WalletAddress showLabel alwaysShowOptions address={address} addressStyle={{ padding: 0 }} />
        </Space>
        }
      >
        {children}
        <AverageRow justify='space-between'>
          <Divider />
          <Button size='large' type='link' onClick={onClose} danger style={{ padding: 0 }}>Cancel</Button>
          {section === Subsections.confirm && moreAuthRequired && <Button size='large' type='default' shape='round' onClick={resetOtps}>Reset</Button>}
        </AverageRow>
      </AnimatedSection>
    )
  }, [address])

  if (majorVersion < 14) {
    return (
      <Subsection onClose={onClose}>
        <Warning>Your wallet is too old to use this feature. Please use a wallet that is at least version 14.1</Warning>
      </Subsection>
    )
  }

  return (
    <>
      {section === Subsections.init &&
        <Subsection onClose={onClose}>
          <TallRow>
            <Space direction='vertical'>
              <Text>Renewing a wallet extends its expiry time by another {humanizeDuration(WalletConstants.defaultDuration, { largest: 1, round: true })}, and gives you an opportunity to bind a new authenticator code to the wallet.</Text>
              {(!wallet.innerRoots || !wallet.innerRoots.length) && <Text>Since your wallet was created prior to v15, renewing the wallet also unlocks many v15 features for your wallet</Text>}
            </Space>
          </TallRow>
          <Divider />
          <TallRow>
            <Title level={3}>Set up a new authenticator code?</Title>
          </TallRow>
          <TallRow>
            <Space direction='vertical' size='large' style={{ width: '100%' }} align='center'>
              <Button shape='round' size='large' type='primary' onClick={() => setMethod('scan')}>Use the same</Button>
              <Hint>(Google or Aegis Authenticator only) Export and scan seed QR Code</Hint>
            </Space>

          </TallRow>
          <Divider><Hint>Or</Hint></Divider>
          <TallRow>
            <Space direction='vertical' size='large' style={{ width: '100%' }} align='center'>
              <Button shape='round' size='large' type='primary' onClick={() => setMethod('new')}>Setup new code</Button>
              <Hint>If you have the wallet on other devices, your old auth code may still work on other devices.</Hint>
            </Space>
          </TallRow>
        </Subsection>}
      {section === Subsections.scan &&
        <Subsection onClose={onClose}>
          {!confirmName &&
            <Space direction='vertical' style={{ width: '100%' }}>
              <ScanGASteps />
              <QrCodeScanner shouldInit={section === Subsections.scan} onScan={onScan} />
            </Space>}
          {confirmName &&
            <Space direction='vertical'>
              <AverageRow>
                <Text>You scanned a code for wallet <b>{confirmName}</b>, but your wallet's name is <b>{wallet.name}</b>. This means you might have scanned the wrong code.</Text>
              </AverageRow>
              <AverageRow>
                <Text style={{ color: 'red' }}> Are you sure to allow using this code from now on for this wallet?</Text>
              </AverageRow>
              <AverageRow justify='space-between'>
                <Button shape='round' onClick={cancelUseName}>Scan again</Button>
                <Button shape='round' type='primary' onClick={confirmUseName}>Yes, I understand</Button>
              </AverageRow>
            </Space>}

        </Subsection>}
      {section === Subsections.new &&
        <Subsection onClose={onClose}>
          <Space direction='vertical' align='center' style={{ width: '100%' }}>
            <Hint>Scan or tap the QR code to setup a new authenticator code</Hint>
            {!showSecondCode &&
              <>
                {buildQRCodeComponent({ seed, name, os, isMobile, qrCodeData })}
                <OtpSetup isMobile={isMobile} otpRef={validationOtpRef} otpValue={validationOtp} setOtpValue={setValidationOtp} name={ONENames.nameWithTime(name, effectiveTime)} />
                {(dev || expert) && <TwoCodeOption isMobile={isMobile} setDoubleOtp={setDoubleOtp} doubleOtp={doubleOtp} />}
              </>}
            {showSecondCode &&
              <>
                {buildQRCodeComponent({ seed, name, os, isMobile, qrCodeData: secondOtpQrCodeData })}
                <OtpSetup isMobile={isMobile} otpRef={validationOtpRef} otpValue={validationOtp} setOtpValue={setValidationOtp} name={ONENames.nameWithTime(getSecondCodeName(name), effectiveTime)} />
              </>}
          </Space>
        </Subsection>}
      {section === Subsections.confirm &&
        <Subsection onClose={onClose}>
          <AverageRow>
            <Hint>If you use the wallet on multiple devices, you may need to renew it on each device, or delete then restore them on other devices.</Hint>
          </AverageRow>
          <AverageRow>
            {method === 'new' &&
              <Space direction='vertical'>
                <Text style={{ color: 'red' }}>You should use new auth code from now on, but your old auth code may still work for this wallet on other devices.</Text>
                <Text>Use your old auth codes to confirm this operation. </Text>
                <Text>- {autoWalletNameHint(wallet)}</Text>
                {
                  wallet?.oldInfos?.length &&
                    <>
                      <Text style={{ marginTop: 24 }}>This wallet was renewed before. Your old auth code account could also be one of the followings:</Text>
                      {name.split(' ').length >= 3 && <Text>- {ONENames.nameWithTime(name)}</Text>}
                      {wallet.oldInfos.map(o => o.effectiveTime).map(t => ONENames.nameWithTime(name, t)).map(str => <Text key={str}>- {str}</Text>)}
                    </>
                }
              </Space>}
          </AverageRow>
          {!root && <WalletCreateProgress title='Computing security parameters...' progress={progress} isMobile={isMobile} progressStage={progressStage} />}
          <AverageRow align='middle'>
            <Col span={24}>
              {moreAuthRequired &&
                <OtpSuperStack
                  otpStates={otpStates}
                  action={`confirm ${method === 'new' ? 'using old auth codes' : ''}`}
                  wideLabel={isMobile}
                  shouldAutoFocus
                  onComplete={doReplace}
                  isDisabled={stage >= 0}
                />}
              {!moreAuthRequired &&
                <OtpStack
                  isDisabled={!root}
                  walletName={autoWalletNameHint(wallet)}
                  otpState={otpState}
                  onComplete={doReplace}
                  action={`confirm ${method === 'new' ? 'using old auth code' : ''}`}
                />}
            </Col>
          </AverageRow>
          <CommitRevealProgress stage={stage} style={{ marginTop: 32 }} />
        </Subsection>}
    </>

  )
}

export default Extend
