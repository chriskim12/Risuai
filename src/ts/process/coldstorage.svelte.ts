import {
    writeFile,
    BaseDirectory,
    readFile,
    exists,
    mkdir,
    remove
} from "@tauri-apps/plugin-fs"
import { forageStorage } from "../globalApi.svelte"
import { isMobile, isTauri, isNodeServer } from "src/ts/platform"
import { DBState, selectedCharID } from "../stores.svelte"
import type { NodeStorage } from "../storage/nodeStorage"
import { fetchProtectedResource } from "../sionyw"
import type { Chat } from "../storage/database.svelte"
import { get } from "svelte/store"

export const coldStorageHeader = '\uEF01COLDSTORAGE\uEF01'
export const hotChatStorageHeader = '\uEF01CHATOFFLOAD\uEF01'
const hotChatStoragePrefix = 'chatcache/'
const hotChatOffloadMessageThreshold = 24
let hotChatOffloadDirty = true
let hotChatOffloadPromise: Promise<string[]> | null = null
let hotChatOffloadTimer: ReturnType<typeof setTimeout> | null = null
const pendingOffloadedCharacterIds = new Set<string>()
let recentHotChatKey: string | null = null

function getChatMemoryKey(characterId:string, chatId:string){
    return `${characterId}::${chatId}`
}

function isRecentHotChat(characterId:string, chatId:string){
    return recentHotChatKey === getChatMemoryKey(characterId, chatId)
}

export function rememberActiveChatAsRecentHot(){
    if(!isMobile){
        return
    }
    const selectedIndex = get(selectedCharID)
    if(selectedIndex < 0){
        return
    }
    const character = DBState.db?.characters?.[selectedIndex]
    const chat = character?.chats?.[character.chatPage]
    if(!character?.chaId || !chat?.id){
        return
    }
    recentHotChatKey = getChatMemoryKey(character.chaId, chat.id)
}

async function decompress(data:Uint8Array) {
    const fflate = await import('fflate')
    return new Promise<Uint8Array>((resolve, reject) => {
        fflate.decompress(data, (err, decompressed) => {
            if (err) {
                reject(err)
            }
            resolve(decompressed)
        })
    })
}

async function getColdStorageItem(key:string) {

    if(forageStorage.isAccount){
        const d = await fetchProtectedResource('/hub/account/coldstorage', {
            method: 'GET',
            headers: {
                'x-risu-key': key,
            }
        })

        if(d.status === 200){
            const buf = await d.arrayBuffer()
            const text = new TextDecoder().decode(await decompress(new Uint8Array(buf)))
            return JSON.parse(text)
        }
        return null
    }
    else if(isNodeServer){
        try {
            const storage = forageStorage.realStorage as NodeStorage
            const f = await storage.getItem('coldstorage/' + key)
            if(!f){
                return null
            }
            const text = new TextDecoder().decode(await decompress(new Uint8Array(f)))
            return JSON.parse(text)
        }
        catch (error) {
            return null
        }
    }
    else if(isTauri){
        try {
            const f = await readFile('./coldstorage/'+key+'.json', {
                baseDir: BaseDirectory.AppData
            })
            const text = new TextDecoder().decode(await decompress(new Uint8Array(f)))
            return JSON.parse(text)
        } catch (error) {
            return null
        }
    }
    else{
        //use opfs
        try {
            const opfs = await navigator.storage.getDirectory()
            const file = await opfs.getFileHandle('coldstorage_' + key+'.json')
            if(!file){
                return null
            }
            const d = await file.getFile()
            if(!d){
                return null
            }
            const buf = await d.arrayBuffer()
            const text = new TextDecoder().decode(await decompress(new Uint8Array(buf)))
            return JSON.parse(text)
        } catch (error) {
            return null
        }
    }
}

async function setColdStorageItem(key:string, value:any) {

    const fflate = await import('fflate')
    const json = JSON.stringify(value)
    const compressed = await (new Promise<Uint8Array>((resolve, reject) => {   
        fflate.compress(new TextEncoder().encode(json), (err, compressed) => {
            if (err) {
                reject(err)
            }
            resolve(compressed)
        })
    }))
    
    if(forageStorage.isAccount){
        const res = await fetchProtectedResource('/hub/account/coldstorage', {
            method: 'POST',
            headers: {
                'x-risu-key': key,
                'content-type': 'application/json'
            },
            body: compressed as any
        })
        if(res.status !== 200){
            try {
                console.error('Error setting cold storage item')
                console.error(await res.text())   
            } catch (error) {}
        }
        return
    }
    else if(isNodeServer){
        try {
            const storage = forageStorage.realStorage as NodeStorage
            await storage.setItem('coldstorage/' + key, compressed)
            return
        } catch (error) {
            console.error(error)
        }
    }

    else if(isTauri){
        try {
            if(!(await exists('./coldstorage'))){
                await mkdir('./coldstorage', { recursive: true, baseDir: BaseDirectory.AppData })
            }
            await writeFile('./coldstorage/'+key+'.json', compressed, { baseDir: BaseDirectory.AppData })
        } catch (error) {
            console.error(error)
        }
    }
    else{
        //use opfs
        try {
            const opfs = await navigator.storage.getDirectory()
            const file = await opfs.getFileHandle('coldstorage_' + key+'.json', { create: true })
            const writable = await file.createWritable()
            await writable.write(compressed as any)
            await writable.close()
        } catch (error) {
            console.error(error)
        }
    }
}

async function getCompressedJsonItem(key:string) {
    const stored = await forageStorage.getItem(key)
    if(!stored){
        return null
    }
    const text = new TextDecoder().decode(await decompress(new Uint8Array(stored)))
    return JSON.parse(text)
}

async function setCompressedJsonItem(key:string, value:any) {
    const fflate = await import('fflate')
    const json = JSON.stringify(value)
    const compressed = await (new Promise<Uint8Array>((resolve, reject) => {
        fflate.compress(new TextEncoder().encode(json), (err, result) => {
            if (err) {
                reject(err)
                return
            }
            resolve(result)
        })
    }))
    await forageStorage.setItem(key, compressed)
}

function getHotChatStorageKey(characterId:string, chatId:string){
    return `${hotChatStoragePrefix}${characterId}/${chatId}.bin`
}

function getLatestChatTimestamp(chat:Chat){
    let latest = chat.lastDate ?? 0
    for(const message of chat.message ?? []){
        if((message?.time ?? 0) > latest){
            latest = message.time
        }
    }
    return latest || Date.now()
}

function isColdStorageChat(chat?:Chat|null){
    return Boolean(chat?.message?.[0]?.data?.startsWith(coldStorageHeader))
}

function isHotOffloadedChat(chat?:Chat|null){
    return Boolean(chat?.message?.[0]?.data?.startsWith(hotChatStorageHeader))
}

export function isExternallyStoredChat(chat?:Chat|null){
    return isColdStorageChat(chat) || isHotOffloadedChat(chat)
}

function buildHotChatPayload(chat:Chat){
    return {
        message: chat.message,
        note: chat.note,
        localLore: chat.localLore,
        sdData: chat.sdData,
        supaMemoryData: chat.supaMemoryData,
        hypaV2Data: chat.hypaV2Data,
        lastMemory: chat.lastMemory,
        suggestMessages: chat.suggestMessages,
        isStreaming: chat.isStreaming,
        scriptstate: chat.scriptstate,
        modules: chat.modules,
        bindedPersona: chat.bindedPersona,
        fmIndex: chat.fmIndex,
        hypaV3Data: chat.hypaV3Data,
        folderId: chat.folderId,
        lastDate: chat.lastDate,
        bookmarks: chat.bookmarks,
        bookmarkNames: chat.bookmarkNames,
    }
}

function createOffloadErrorMessage(storageKey:string, lastDate = Date.now()){
    console.warn(`Failed to restore offloaded chat payload from ${storageKey}`)
    return [{
        role: 'char' as const,
        data: '[Failed to restore offloaded chat data]',
        time: lastDate,
        isComment: true,
    }]
}

function restoreHotChatPayload(chat:Chat, payload:ReturnType<typeof buildHotChatPayload>){
    chat.message = payload.message ?? []
    chat.note = payload.note ?? ''
    chat.localLore = payload.localLore ?? []
    chat.sdData = payload.sdData
    chat.supaMemoryData = payload.supaMemoryData
    chat.hypaV2Data = payload.hypaV2Data
    chat.lastMemory = payload.lastMemory
    chat.suggestMessages = payload.suggestMessages
    chat.isStreaming = payload.isStreaming
    chat.scriptstate = payload.scriptstate
    chat.modules = payload.modules
    chat.bindedPersona = payload.bindedPersona
    chat.fmIndex = payload.fmIndex
    chat.hypaV3Data = payload.hypaV3Data
    chat.folderId = payload.folderId
    chat.lastDate = payload.lastDate
    chat.bookmarks = payload.bookmarks
    chat.bookmarkNames = payload.bookmarkNames
}

function replaceChatWithHotPlaceholder(chat:Chat, storageKey:string){
    const latest = getLatestChatTimestamp(chat)
    chat.message = [{
        time: latest,
        data: hotChatStorageHeader + storageKey,
        role: 'char',
        isComment: true,
    }]
    chat.note = ''
    chat.localLore = []
    chat.sdData = ''
    chat.supaMemoryData = ''
    chat.hypaV2Data = undefined
    chat.lastMemory = ''
    chat.suggestMessages = []
    chat.scriptstate = {}
    chat.modules = []
    chat.hypaV3Data = undefined
    chat.lastDate = latest
}

export function markInactiveChatsDirty(){
    hotChatOffloadDirty = true
}

export function scheduleOffloadInactiveChats(delay = 250){
    markInactiveChatsDirty()
    if(!isMobile){
        return
    }
    if(hotChatOffloadTimer){
        clearTimeout(hotChatOffloadTimer)
    }
    hotChatOffloadTimer = setTimeout(() => {
        hotChatOffloadTimer = null
        void offloadInactiveChats()
    }, delay)
}

export function consumeOffloadedCharacterIds(){
    const ids = [...pendingOffloadedCharacterIds]
    pendingOffloadedCharacterIds.clear()
    return ids
}

export async function offloadInactiveChats(force = false){
    if(!isMobile){
        return []
    }
    if(!force && !hotChatOffloadDirty){
        return []
    }
    if(hotChatOffloadPromise){
        return await hotChatOffloadPromise
    }

    hotChatOffloadPromise = (async () => {
        const currentCharacterIndex = get(selectedCharID)
        const touchedCharacterIds = new Set<string>()

        for(let characterIndex = 0; characterIndex < DBState.db.characters.length; characterIndex++){
            const character = DBState.db.characters[characterIndex]
            for(let chatIndex = 0; chatIndex < character.chats.length; chatIndex++){
                if(characterIndex === currentCharacterIndex && chatIndex === character.chatPage){
                    continue
                }

                const chat = character.chats[chatIndex]
                if(!chat?.id || chat.isStreaming){
                    continue
                }
                if(isRecentHotChat(character.chaId, chat.id)){
                    continue
                }
                if(isExternallyStoredChat(chat)){
                    continue
                }
                if((chat.message?.length ?? 0) <= hotChatOffloadMessageThreshold){
                    continue
                }

                const storageKey = getHotChatStorageKey(character.chaId, chat.id)
                await setCompressedJsonItem(storageKey, buildHotChatPayload(chat))
                replaceChatWithHotPlaceholder(chat, storageKey)
                touchedCharacterIds.add(character.chaId)
                pendingOffloadedCharacterIds.add(character.chaId)
            }
        }

        hotChatOffloadDirty = false
        return [...touchedCharacterIds]
    })()

    try{
        return await hotChatOffloadPromise
    } finally {
        hotChatOffloadPromise = null
    }
}

async function removeColdStorageItem(key:string) {
    if(isTauri){
        try {
            await remove('./coldstorage/'+key+'.json')
        } catch (error) {
            console.error(error)
        }
    }
    else{
        //use opfs
        try {
            const opfs = await navigator.storage.getDirectory()
            await opfs.removeEntry('coldstorage_' + key+'.json')
        } catch (error) {
            console.error(error)
        }
    }
}

export async function makeColdData(){

    if(!DBState.db.chatCompression){
        return
    }

    const currentTime = Date.now()
    const coldTime = currentTime - 1000 * 60 * 60 * 24 * 30 //30 days before now

    for(let i=0;i<DBState.db.characters.length;i++){
        for(let j=0;j<DBState.db.characters[i].chats.length;j++){
            
            const chat = DBState.db.characters[i].chats[j]
            let greatestTime = chat.lastDate ?? 0

            if(chat.message.length < 4){
                //it is inefficient to store small data
                continue
            }

            if(chat.message?.[0]?.data?.startsWith(coldStorageHeader)){
                //already cold storage
                continue
            }


            for(let k=0;k<chat.message.length;k++){
                const message = chat.message[k]
                const time = message.time
                if(!time){
                    continue
                }

                if(time > greatestTime){
                    greatestTime = time
                }
            }

            if(greatestTime < coldTime){
                const id = crypto.randomUUID()
                await setColdStorageItem(id, {
                    message: chat.message,
                    hypaV2Data: chat.hypaV2Data,
                    hypaV3Data: chat.hypaV3Data,
                    scriptstate: chat.scriptstate,
                    localLore: chat.localLore
                })
                chat.message = [{
                    time: currentTime,
                    data: coldStorageHeader + id,
                    role: 'char'
                }]
                chat.hypaV2Data = {
                    chunks:[],
                    mainChunks: [],
                    lastMainChunkID: 0,
                }
                chat.hypaV3Data = {
                    summaries:[]
                }
                chat.scriptstate = {}
                chat.localLore = []

            }
        }
    }
}

export async function preLoadChat(characterIndex:number, chatIndex:number){
    const chat = DBState.db?.characters?.[characterIndex]?.chats?.[chatIndex]   

    if(!chat){
        return
    }

    if(isColdStorageChat(chat)){
        //bring back from cold storage
        const coldDataKey = chat.message[0].data.slice(coldStorageHeader.length)
        const coldData = await getColdStorageItem(coldDataKey)
        if(coldData && Array.isArray(coldData)){
            chat.message = coldData
            chat.lastDate = Date.now()
        }
        else if(coldData){
            chat.message = coldData.message
            chat.hypaV2Data = coldData.hypaV2Data
            chat.hypaV3Data = coldData.hypaV3Data
            chat.scriptstate = coldData.scriptstate
            chat.localLore = coldData.localLore
        }
        await setColdStorageItem(coldDataKey + '_accessMeta', {
            lastAccess: Date.now()
        })
    }
    else if(isHotOffloadedChat(chat)){
        const storageKey = chat.message[0].data.slice(hotChatStorageHeader.length)
        const hotData = await getCompressedJsonItem(storageKey)
        if(hotData){
            restoreHotChatPayload(chat, hotData)
            chat.lastDate = getLatestChatTimestamp(chat)
        }
        else{
            chat.message = createOffloadErrorMessage(storageKey, chat.lastDate)
            chat.lastDate = getLatestChatTimestamp(chat)
        }
    }

}
