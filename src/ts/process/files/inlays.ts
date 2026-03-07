import localforage from "localforage";
import { v4 } from "uuid";
import { getImageType } from "src/ts/media";
import { getDatabase } from "../../storage/database.svelte";
import { getModelInfo, LLMFlags } from "src/ts/model/modellist";
import { asBuffer } from "../../util";
import { inlayTokenRegex, type InlayTokenKind } from "../../util/inlayTokens";

export type InlayAsset = {
    data: string | Blob
    /** File extension */
    ext: string
    height: number
    name: string
    type: 'image' | 'video' | 'audio'
    width: number
}

const inlayImageExts = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'
]

const inlayAudioExts = [
    'wav', 'mp3', 'ogg', 'flac'
]

const inlayVideoExts = [
    'webm', 'mp4', 'mkv'
]

const inlayStorage = localforage.createInstance({
    name: 'inlay',
    storeName: 'inlay'
})

let globalApiModulePromise: Promise<typeof import("../../globalApi.svelte")> | null = null

function loadGlobalApiModule() {
    globalApiModulePromise ??= import("../../globalApi.svelte")
    return globalApiModulePromise
}

function cloneInlayTokenRegex() {
    return new RegExp(inlayTokenRegex.source, inlayTokenRegex.flags)
}

function getAssetTypeFromExt(ext: string): InlayAsset['type'] | null {
    const normalized = ext.toLowerCase()
    if (inlayImageExts.includes(normalized)) {
        return 'image'
    }
    if (inlayAudioExts.includes(normalized)) {
        return 'audio'
    }
    if (inlayVideoExts.includes(normalized)) {
        return 'video'
    }
    return null
}

function getMimeType(type: InlayAsset['type'], ext: string) {
    const normalized = ext.toLowerCase()
    if (type === 'image') {
        return normalized === 'jpg' ? 'image/jpeg' : `image/${normalized}`
    }
    if (type === 'audio') {
        return `audio/${normalized}`
    }
    return `video/${normalized}`
}

function getFileExtension(name: string) {
    return name.split('.').at(-1)?.toLowerCase() ?? ''
}

function getFileName(path: string) {
    return path.split('/').at(-1) ?? path
}

function getPngFileName(name?: string) {
    const baseName = name?.split('/').at(-1)?.replace(/\.[^.]+$/, '') || v4()
    return `${baseName}.png`
}

async function waitForImage(imgObj: HTMLImageElement) {
    if (imgObj.complete && (imgObj.naturalWidth > 0 || imgObj.width > 0)) {
        return
    }

    await new Promise<void>((resolve, reject) => {
        imgObj.onload = () => resolve()
        imgObj.onerror = () => reject(new Error('Failed to load inlay image'))
    })
}

async function drawInlayImage(imgObj: HTMLImageElement) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
        throw new Error('Failed to get canvas context for inlay image')
    }

    await waitForImage(imgObj)

    let drawHeight = imgObj.naturalHeight || imgObj.height
    let drawWidth = imgObj.naturalWidth || imgObj.width

    const maxPixels = 1024 * 1024
    const currentPixels = drawHeight * drawWidth

    if (currentPixels > maxPixels) {
        const scaleFactor = Math.sqrt(maxPixels / currentPixels)
        drawWidth = Math.floor(drawWidth * scaleFactor)
        drawHeight = Math.floor(drawHeight * scaleFactor)
    }

    canvas.width = drawWidth
    canvas.height = drawHeight
    ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)

    const imageBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!imageBlob) {
        throw new Error('Failed to encode inlay image as PNG')
    }

    return {
        imageBlob,
        drawHeight,
        drawWidth,
    }
}

async function getPersistentInlayAssetBlob(id: string): Promise<InlayAsset | null> {
    const ext = getFileExtension(id)
    const type = getAssetTypeFromExt(ext)
    if (!type) {
        return null
    }

    try {
        const { readImage } = await loadGlobalApiModule()
        const data = await readImage(id)
        if (!data) {
            return null
        }

        return {
            data: new Blob([asBuffer(data)], { type: getMimeType(type, ext) }),
            ext,
            height: 0,
            width: 0,
            name: getFileName(id),
            type,
        }
    } catch (error) {
        console.error('Failed to read persistent inlay asset:', error)
        return null
    }
}

export function isPersistentInlayRef(id: string) {
    return id.startsWith('assets/')
}

export async function postInlayAsset(img:{
    name:string,
    data:Uint8Array
}){

    const extention = getFileExtension(img.name)
    const imgObj = new Image()

    if(inlayImageExts.includes(extention)){
        const objectUrl = URL.createObjectURL(new Blob([asBuffer(img.data)], {type: `image/${extention}`}))
        try {
            imgObj.src = objectUrl
            return await writePersistentInlayImage(imgObj, {
                name: img.name,
                ext: extention
            })
        } finally {
            URL.revokeObjectURL(objectUrl)
        }
    }

    if(inlayAudioExts.includes(extention)){
        const audioBlob = new Blob([asBuffer(img.data)], {type: `audio/${extention}`})
        const imgid = v4()

        await inlayStorage.setItem(imgid, {
            name: img.name,
            data: await blobToBase64(audioBlob),
            ext: extention,
            type: 'audio'
        })

        return `${imgid}`
    }

    if(inlayVideoExts.includes(extention)){
        const videoBlob = new Blob([asBuffer(img.data)], {type: `video/${extention}`})
        const imgid = v4()

        await inlayStorage.setItem(imgid, {
            name: img.name,
            data: await blobToBase64(videoBlob),
            ext: extention,
            type: 'video'
        })

        return `${imgid}`
    }

    return null
}

export async function writeInlayImage(imgObj:HTMLImageElement, arg:{name?:string, ext?:string, id?:string} = {}) {
    const { imageBlob, drawHeight, drawWidth } = await drawInlayImage(imgObj)
    // Store as base64 string — iOS/WebKit IndexedDB cannot serialize Blob objects
    const imageData = await blobToBase64(imageBlob);

    const imgid = arg.id ?? v4()

    await inlayStorage.setItem(imgid, {
        name: arg.name ?? imgid,
        data: imageData,
        ext: 'png',
        height: drawHeight,
        width: drawWidth,
        type: 'image'
    })

    return `${imgid}`
}

export async function writePersistentInlayImage(imgObj:HTMLImageElement, arg:{name?:string, ext?:string} = {}) {
    const { imageBlob } = await drawInlayImage(imgObj)
    const imageBuffer = new Uint8Array(await imageBlob.arrayBuffer())
    const { saveAsset } = await loadGlobalApiModule()
    return await saveAsset(imageBuffer, '', getPngFileName(arg.name))
}

function base64ToBlob(b64: string): Blob {
    const splitDataURI = b64.split(',');
    const byteString = atob(splitDataURI[1]);
    const mimeString = splitDataURI[0].split(':')[1].split(';')[0];

    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }

    return new Blob([ab], { type: mimeString });
}

function blobToBase64(blob: Blob): Promise<string> {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
            resolve(reader.result as string);
        };
        reader.onerror = reject;
    });
}

// Returns with base64 data URI
export async function getInlayAsset(id: string){
    const img = isPersistentInlayRef(id)
        ? await getPersistentInlayAssetBlob(id)
        : await inlayStorage.getItem<InlayAsset | null>(id)
    if(img === null){
        return null
    }

    let data: string;
    if(img.data instanceof Blob){
        data = await blobToBase64(img.data)
    } else {
        data = img.data as string
    }

    return { ...img, data }
}

// Returns with Blob
export async function getInlayAssetBlob(id: string){
    const img = isPersistentInlayRef(id)
        ? await getPersistentInlayAssetBlob(id)
        : await inlayStorage.getItem<InlayAsset | null>(id)
    if(img === null){
        return null
    }

    let data: Blob;
    if(typeof img.data === 'string'){
        data = base64ToBlob(img.data)
    } else {
        data = img.data
    }

    return { ...img, data }
}

export async function migrateLegacyImageInlayRefs(text: string): Promise<{ text: string, changed: boolean }> {
    if (!text.includes('{{inlay')) {
        return { text, changed: false }
    }

    const matches = [...text.matchAll(cloneInlayTokenRegex())]
    if (matches.length === 0) {
        return { text, changed: false }
    }

    const migrated = new Map<string, string | null>()
    let changed = false
    let cursor = 0
    let migratedText = ''

    for (const match of matches) {
        const fullMatch = match[0]
        const tokenKind = match[1] as InlayTokenKind
        const ref = match[2]
        const start = match.index ?? 0
        migratedText += text.slice(cursor, start)
        cursor = start + fullMatch.length

        if (isPersistentInlayRef(ref)) {
            migratedText += fullMatch
            continue
        }

        if (!migrated.has(ref)) {
            let nextRef: string | null = null
            const asset = await getInlayAssetBlob(ref)
            if (asset?.type === 'image') {
                const image = new Image()
                const objectUrl = URL.createObjectURL(asset.data as Blob)
                try {
                    image.src = objectUrl
                    nextRef = await writePersistentInlayImage(image, { name: asset.name })
                } finally {
                    URL.revokeObjectURL(objectUrl)
                }
            }
            migrated.set(ref, nextRef)
        }

        const nextRef = migrated.get(ref)
        if (!nextRef) {
            migratedText += fullMatch
            continue
        }

        changed = true
        migratedText += `{{${tokenKind}::${nextRef}}}`
    }

    migratedText += text.slice(cursor)
    return { text: migratedText, changed }
}

export async function listInlayAssets(): Promise<[id: string, InlayAsset][]> {
    const assets: [id: string, InlayAsset][] = []
    await inlayStorage.iterate<InlayAsset, void>((value, key) => {
        assets.push([key, value])
    })

    return assets
}

export async function setInlayAsset(id: string, img: InlayAsset){
    await inlayStorage.setItem(id, img)
}

export async function removeInlayAsset(id: string){
    await inlayStorage.removeItem(id)
}

export function supportsInlayImage(){
    const db = getDatabase()
    return getModelInfo(db.aiModel).flags.includes(LLMFlags.hasImageInput)
}

export async function reencodeImage(img:Uint8Array){
    if(getImageType(img) === 'PNG'){
        return img
    }
    const canvas = document.createElement('canvas')
    const imgObj = new Image()
    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], {type: `image/png`}))
    await imgObj.decode()
    let drawHeight = imgObj.height
    let drawWidth = imgObj.width
    canvas.width = drawWidth
    canvas.height = drawHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
    const b64 = canvas.toDataURL('image/png').split(',')[1]
    const b = Buffer.from(b64, 'base64')
    return b
}
