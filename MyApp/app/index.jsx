import {
  StyleSheet, Text, View, Pressable, Image,
  StatusBar, Animated, Alert, TextInput,
  KeyboardAvoidingView, Platform, Dimensions, ActivityIndicator,
} from 'react-native'
import { useState, useRef, useEffect } from 'react'
import { CameraView, useCameraPermissions } from 'expo-camera'
import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import { loadTensorflowModel } from 'react-native-fast-tflite'
import Svg, { Rect } from 'react-native-svg'
const jpeg = require('jpeg-js')

const { width: SW } = Dimensions.get('window')
const MODEL_SIZE    = 640
const CONF_THR      = 0.25
const IOU_THR       = 0.45
const SERVER_URL    = process.env.EXPO_PUBLIC_SERVER_URL
const QUEUE_KEY     = 'upload_queue'
const NAME_KEY      = 'user_name'
const USED_IDS_KEY  = 'used_ids'
const ZOOM_LEVELS   = [{ label: '1x', value: 0 }, { label: '2x', value: 0.5 }]

// ── Unique filename ─────────────────────────────────────────────────
const generateFilename = async (name) => {
  const raw  = await AsyncStorage.getItem(USED_IDS_KEY)
  const used = raw ? new Set(JSON.parse(raw)) : new Set()
  let n
  do { n = Math.floor(100000 + Math.random() * 900000) } while (used.has(n))
  used.add(n)
  await AsyncStorage.setItem(USED_IDS_KEY, JSON.stringify([...used]))
  return `${name.trim().toLowerCase().replace(/\s+/g, '_')}_${n}`
}

// ── NMS helpers ─────────────────────────────────────────────────────
const iou = (a, b) => {
  const inter =
    Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) *
    Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  return inter / ((a.x2-a.x1)*(a.y2-a.y1) + (b.x2-b.x1)*(b.y2-b.y1) - inter)
}

const applyNMS = (boxes) => {
  boxes.sort((a, b) => b.conf - a.conf)
  const out = [], sup = new Set()
  for (let i = 0; i < boxes.length; i++) {
    if (sup.has(i)) continue
    out.push(boxes[i])
    for (let j = i + 1; j < boxes.length; j++)
      if (iou(boxes[i], boxes[j]) > IOU_THR) sup.add(j)
  }
  return out
}

// ── Decode TFLite output ─────────────────────────────────────────────
// Output shape: [1, 5, 8400]
// Each anchor: cx, cy, w, h (pixel space 0-640), conf (0-1)
// This is equivalent to results.boxes from ultralytics Python
const decodeOutput = (raw) => {
  const N = 8400
  const boxes = []
  for (let i = 0; i < N; i++) {
    const conf = raw[4 * N + i]
    if (conf < CONF_THR) continue
    const cx = raw[0*N+i], cy = raw[1*N+i], w = raw[2*N+i], h = raw[3*N+i]
    boxes.push({
      x1: Math.max(0, cx - w/2),
      y1: Math.max(0, cy - h/2),
      x2: Math.min(1, cx + w/2),
      y2: Math.min(1, cy + h/2),
      conf,
    })
  }
  return applyNMS(boxes)
}

// ── Base64 → Uint8Array ──────────────────────────────────────────────
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const b64toBytes = (b64) => {
  // Manual decode — avoids relying on global atob in all RN/Hermes configs
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const len   = Math.floor(clean.length * 3 / 4)
  const out   = new Uint8Array(len)
  let pos = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_CHARS.indexOf(clean[i])
    const b = B64_CHARS.indexOf(clean[i+1])
    const c = B64_CHARS.indexOf(clean[i+2])
    const d = B64_CHARS.indexOf(clean[i+3])
    out[pos++] = (a << 2) | (b >> 4)
    if (c !== -1) out[pos++] = ((b & 0xf) << 4) | (c >> 2)
    if (d !== -1) out[pos++] = ((c & 0x3) << 6) | d
  }
  return out.subarray(0, pos)
}

// ── Component ───────────────────────────────────────────────────────
export default function Home() {
  const [permission, requestPermission] = useCameraPermissions()
  const [facing, setFacing]         = useState('back')
  const [activeZoom, setActiveZoom] = useState('1x')
  const [zoom, setZoom]             = useState(0)
  const [userName, setUserName]     = useState(null)   // null = loading
  const [nameInput, setNameInput]   = useState('')
  const [screen, setScreen]         = useState('camera') // 'camera' | 'analyzing' | 'result'
  const [result, setResult]         = useState(null)     // { imageUri, boxes }
  const [modelReady, setModelReady] = useState(false)

  const cameraRef   = useRef(null)
  const modelRef    = useRef(null)
  const busy        = useRef(false)
  const uploadQueue = useRef([])   // [{ uri, filename }]
  const processing  = useRef(false)

  // ── Animations ────────────────────────────────────────────────────
  const flashOpacity    = useRef(new Animated.Value(0)).current
  const shutterScale    = useRef(new Animated.Value(1)).current
  const controlsOpacity = useRef(new Animated.Value(0)).current
  const controlsY       = useRef(new Animated.Value(60)).current

  // ── Load name + model on mount ────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(NAME_KEY).then(saved => setUserName(saved || ''))

    loadTensorflowModel(require('../assets/best_float32.tflite'))
      .then(m => { modelRef.current = m; setModelReady(true) })
      .catch(e => console.error('[model load error]', e))
  }, [])

  // ── Initialize queue + animations when name is ready ─────────────
  useEffect(() => {
    if (!userName) return
    loadSavedQueue()
    const unsub = NetInfo.addEventListener(s => { if (s.isConnected) processNextInQueue() })
    Animated.parallel([
      Animated.timing(controlsOpacity, { toValue: 1, duration: 500, useNativeDriver: true, delay: 200 }),
      Animated.timing(controlsY,       { toValue: 0, duration: 500, useNativeDriver: true, delay: 200 }),
    ]).start()
    return () => unsub()
  }, [userName])

  // ── Name submit ───────────────────────────────────────────────────
  const handleNameSubmit = async () => {
    const t = nameInput.trim()
    if (!t) return
    await AsyncStorage.setItem(NAME_KEY, t)
    setUserName(t)
  }

  // ── Queue helpers ─────────────────────────────────────────────────
  const loadSavedQueue = async () => {
    try {
      const saved = await AsyncStorage.getItem(QUEUE_KEY)
      if (saved) {
        const items = JSON.parse(saved)
        if (items.length > 0) { uploadQueue.current = items; processNextInQueue() }
      }
    } catch {}
  }

  const saveQueue = async (items) => {
    try { await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items)) } catch {}
  }

  // ── Upload queue processor ────────────────────────────────────────
  const processNextInQueue = async () => {
    if (processing.current || uploadQueue.current.length === 0) return
    const net = await NetInfo.fetch()
    if (!net.isConnected) return
    processing.current = true
    const { uri, filename } = uploadQueue.current[0]
    try {
      const form = new FormData()
      form.append('file', { uri, name: 'photo.jpg', type: 'image/jpeg' })
      form.append('filename', filename)
      await fetch(`${SERVER_URL}/upload`, { method: 'POST', body: form })
      uploadQueue.current.shift()
      await saveQueue(uploadQueue.current)
      processing.current = false
      processNextInQueue()
    } catch {
      processing.current = false
      setTimeout(() => processNextInQueue(), 5000)
    }
  }

  // ── Capture ───────────────────────────────────────────────────────
  const handleCapture = async () => {
    if (!cameraRef.current || busy.current || !modelRef.current) return
    busy.current = true
    Animated.sequence([
      Animated.timing(shutterScale, { toValue: 0.84, duration: 75,  useNativeDriver: true }),
      Animated.spring(shutterScale,  { toValue: 1,    useNativeDriver: true, speed: 28, bounciness: 12 }),
    ]).start()
    Animated.sequence([
      Animated.timing(flashOpacity, { toValue: 0.9, duration: 50,  useNativeDriver: true }),
      Animated.timing(flashOpacity, { toValue: 0,   duration: 400, useNativeDriver: true }),
    ]).start()

    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.82, base64: false })

      const filename = await generateFilename(userName)
      uploadQueue.current.push({ uri: photo.uri, filename })
      await saveQueue(uploadQueue.current)
      processNextInQueue()

      setScreen('analyzing')

const resized = await manipulateAsync(
        photo.uri,
        [{ resize: { width: MODEL_SIZE, height: MODEL_SIZE } }],
        { format: SaveFormat.JPEG, base64: true }
      )

      const rawBytes = b64toBytes(resized.base64)
      const decoded  = jpeg.decode(rawBytes, { useTArray: true })
      if (!decoded?.data) throw new Error('jpeg.decode returned no data')
      const rgba = decoded.data

      const input = new Float32Array(MODEL_SIZE * MODEL_SIZE * 3)
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        input[j]   = rgba[i]   / 255
        input[j+1] = rgba[i+1] / 255
        input[j+2] = rgba[i+2] / 255
      }

      const outputs = await modelRef.current.run([input])
      const boxes   = decodeOutput(outputs[0])

      setResult({ imageUri: resized.uri, boxes })
      setScreen('result')

    } catch (e) {
      Alert.alert('Capture Error', String(e))
      setScreen('camera')
    } finally {
      busy.current = false
    }
  }

  const handleZoom = (level) => { setActiveZoom(level.label); setZoom(level.value) }

  // ── Guards ────────────────────────────────────────────────────────
  if (userName === null) return <View style={styles.bg} />
  if (!permission)        return <View style={styles.bg} />

  if (!permission.granted) {
    return (
      <View style={styles.permissionScreen}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.permissionTitle}>Camera Access</Text>
        <Text style={styles.permissionSub}>Required to capture and analyze road conditions</Text>
        <Pressable style={({ pressed }) => [styles.grantBtn, pressed && { opacity: 0.75 }]} onPress={requestPermission}>
          <Text style={styles.grantBtnText}>Allow Camera</Text>
        </Pressable>
      </View>
    )
  }

  if (!userName) {
    return (
      <KeyboardAvoidingView style={styles.nameScreen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.nameTitle}>Welcome</Text>
        <Text style={styles.nameSub}>Enter your name to get started</Text>
        <TextInput
          style={styles.nameInput}
          placeholder="Your name"
          placeholderTextColor="#4b5563"
          value={nameInput}
          onChangeText={setNameInput}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={handleNameSubmit}
        />
        <Pressable
          style={({ pressed }) => [styles.grantBtn, { marginTop: 12 }, (!nameInput.trim() || pressed) && { opacity: 0.5 }]}
          onPress={handleNameSubmit}
        >
          <Text style={styles.grantBtnText}>Continue</Text>
        </Pressable>
      </KeyboardAvoidingView>
    )
  }

  // ── Main UI ───────────────────────────────────────────────────────
  return (
    <View style={styles.bg}>
      <StatusBar barStyle="light-content" hidden />

      {/* Camera — always mounted */}
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} zoom={zoom} />

      {/* Flash overlay */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: flashOpacity }]}
      />


      {/* ── Analyzing overlay ── */}
      {screen === 'analyzing' && (
        <View style={styles.analyzeOverlay}>
          <ActivityIndicator size="large" color="#a78bfa" />
          <Text style={styles.analyzeText}>Analyzing...</Text>
        </View>
      )}

      {/* ── Result overlay ── */}
      {screen === 'result' && result && (
        <View style={styles.resultOverlay}>

          {/* Image + SVG bounding boxes */}
          <View style={styles.imageBox}>
            <Image
              source={{ uri: result.imageUri }}
              style={styles.resultImage}
              resizeMode="stretch"
            />
            <Svg style={StyleSheet.absoluteFill}>
              {result.boxes.map((box, idx) => (
                <Rect
                  key={idx}
                  x={String((box.x1 * SW).toFixed(1))}
                  y={String((box.y1 * SW).toFixed(1))}
                  width={String(((box.x2 - box.x1) * SW).toFixed(1))}
                  height={String(((box.y2 - box.y1) * SW).toFixed(1))}
                  stroke="#FF3B30"
                  strokeWidth="2.5"
                  fill="rgba(255,59,48,0.1)"
                />
              ))}
            </Svg>
          </View>

          {/* Count badge */}
          <View style={[styles.countBadge, result.boxes.length > 0 ? styles.badgeRed : styles.badgeGreen]}>
            <Text style={[styles.countText, { color: result.boxes.length > 0 ? '#FF3B30' : '#4ade80' }]}>
              {result.boxes.length > 0
                ? `${result.boxes.length} Pothole${result.boxes.length > 1 ? 's' : ''} Detected`
                : 'No Potholes Detected'}
            </Text>
          </View>

          {/* Retake */}
          <Pressable
            style={({ pressed }) => [styles.retakeBtn, pressed && { opacity: 0.7 }]}
            onPress={() => { setResult(null); setScreen('camera') }}
          >
            <Text style={styles.retakeText}>Retake</Text>
          </Pressable>

        </View>
      )}

      {/* ── Camera controls — only when on camera screen ── */}
      {screen === 'camera' && (
        <>
          {/* Name chip — tap to change name */}
          <Pressable
            style={styles.nameChip}
            onPress={() => { AsyncStorage.removeItem(NAME_KEY); setUserName(''); setNameInput('') }}
          >
            <Text style={styles.nameChipText}>{userName}  ✕</Text>
          </Pressable>

          {/* Model loading indicator */}
          {!modelReady && (
            <View style={styles.modelBadge}>
              <ActivityIndicator size="small" color="#a78bfa" />
              <Text style={styles.modelBadgeText}>Loading model...</Text>
            </View>
          )}

          <Animated.View style={[styles.bottomBar, { opacity: controlsOpacity, transform: [{ translateY: controlsY }] }]}>

            <View style={styles.zoomRow}>
              {ZOOM_LEVELS.map(level => (
                <Pressable
                  key={level.label}
                  style={[styles.zoomPill, activeZoom === level.label && styles.zoomPillActive]}
                  onPress={() => handleZoom(level)}
                >
                  <Text style={[styles.zoomText, activeZoom === level.label && styles.zoomTextActive]}>
                    {level.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.shutterRow}>
              <Animated.View style={{ transform: [{ scale: shutterScale }] }}>
                <Pressable
                  style={[styles.shutter, !modelReady && { opacity: 0.4 }]}
                  onPress={handleCapture}
                >
                  <View style={styles.shutterInner} />
                </Pressable>
              </Animated.View>
            </View>

            <View style={styles.bottomRow}>
              <View style={styles.bottomSide} />
              <Text style={styles.modeLabel}>PHOTO</Text>
              <View style={styles.bottomSide}>
                <Pressable
                  style={({ pressed }) => [styles.flipBtn, pressed && { opacity: 0.6 }]}
                  onPress={() => setFacing(f => f === 'back' ? 'front' : 'back')}
                >
                  <Text style={styles.flipIcon}>↺</Text>
                </Pressable>
              </View>
            </View>

          </Animated.View>
        </>
      )}
    </View>
  )
}

// ── Styles ───────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: '#000' },

  permissionScreen: { flex:1, backgroundColor:'#080810', alignItems:'center', justifyContent:'center', padding:40 },
  permissionTitle:  { fontSize:22, fontWeight:'700', color:'#fff', marginBottom:10 },
  permissionSub:    { fontSize:14, color:'#6b7280', textAlign:'center', lineHeight:22, marginBottom:36 },

  nameScreen: { flex:1, backgroundColor:'#080810', alignItems:'center', justifyContent:'center', padding:40 },
  nameTitle:  { fontSize:28, fontWeight:'700', color:'#fff', marginBottom:8 },
  nameSub:    { fontSize:14, color:'#6b7280', textAlign:'center', marginBottom:32 },
  nameInput: {
    width:'100%', backgroundColor:'#1a1a2e', borderWidth:1, borderColor:'#ffffff20',
    borderRadius:14, paddingHorizontal:18, paddingVertical:14, fontSize:16, color:'#fff',
  },

  grantBtn:     { backgroundColor:'#a78bfa', paddingHorizontal:32, paddingVertical:14, borderRadius:28 },
  grantBtnText: { color:'#fff', fontSize:15, fontWeight:'700' },

  analyzeOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  analyzeText: { fontSize:16, color:'#ffffffcc', fontWeight:'600', letterSpacing:0.5 },

  resultOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 40,
  },
  imageBox:    { width: SW, height: SW },
  resultImage: { width: SW, height: SW },

  countBadge:  { marginTop:20, paddingHorizontal:24, paddingVertical:10, borderRadius:24, borderWidth:1 },
  badgeRed:    { backgroundColor:'rgba(255,59,48,0.12)',  borderColor:'#FF3B30' },
  badgeGreen:  { backgroundColor:'rgba(74,222,128,0.12)', borderColor:'#4ade80' },
  countText:   { fontSize:15, fontWeight:'700' },

  retakeBtn:  {
    marginTop:16, backgroundColor:'#1a1a2e', borderWidth:1, borderColor:'#ffffff20',
    paddingHorizontal:36, paddingVertical:14, borderRadius:28,
  },
  retakeText: { color:'#fff', fontSize:15, fontWeight:'600' },

  nameChip: {
    position:'absolute', top:20, left:20,
    backgroundColor:'#00000088', borderWidth:1, borderColor:'#ffffff20',
    paddingHorizontal:12, paddingVertical:6, borderRadius:20,
  },
  nameChipText: { color:'#ffffffcc', fontSize:12, fontWeight:'600' },

  modelBadge: {
    position:'absolute', top:20, right:20,
    flexDirection:'row', alignItems:'center', gap:8,
    backgroundColor:'#00000088', borderWidth:1, borderColor:'#ffffff20',
    paddingHorizontal:12, paddingVertical:6, borderRadius:20,
  },
  modelBadgeText: { color:'#ffffffcc', fontSize:12 },

  bottomBar: {
    position:'absolute', bottom:0, left:0, right:0,
    backgroundColor:'#111111ee', paddingBottom:36, paddingTop:16, gap:10,
  },
  zoomRow:       { flexDirection:'row', justifyContent:'center', gap:6, marginBottom:4 },
  zoomPill:      { paddingHorizontal:12, paddingVertical:5, borderRadius:20 },
  zoomPillActive:{ backgroundColor:'#3a3a3c' },
  zoomText:      { fontSize:13, color:'#ffffffaa', fontWeight:'600' },
  zoomTextActive:{ color:'#FFCC00' },

  shutterRow:  { alignItems:'center', marginVertical:8 },
  shutter:     { width:78, height:78, borderRadius:39, borderWidth:3, borderColor:'#fff', alignItems:'center', justifyContent:'center' },
  shutterInner:{ width:62, height:62, borderRadius:31, backgroundColor:'#fff' },

  bottomRow:  { flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:28, marginTop:4 },
  bottomSide: { width:52, alignItems:'flex-end' },
  modeLabel:  { fontSize:14, fontWeight:'700', color:'#FFCC00', letterSpacing:1 },
  flipBtn:    { width:52, height:52, borderRadius:26, backgroundColor:'#3a3a3caa', alignItems:'center', justifyContent:'center' },
  flipIcon:   { fontSize:24, color:'#fff' },
})
