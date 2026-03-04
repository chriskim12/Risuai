type MsgType =
    | 'CALL_ROOT'
    | 'CALL_INSTANCE'
    | 'INVOKE_CALLBACK'
    | 'CALLBACK_RETURN'
    | 'RESPONSE'
    | 'RELEASE_INSTANCE'
    | 'ABORT_SIGNAL';

interface RpcMessage {
    type: MsgType;
    reqId?: string;
    id?: string;
    method?: string;
    args?: any[];
    result?: any;
    error?: string;
    abortId?: string;
}

interface RemoteRef {
    __type: 'REMOTE_REF';
    id: string;
}

interface CallbackRef {
    __type: 'CALLBACK_REF';
    id: string;
}

interface AbortSignalRef {
    __type: 'ABORT_SIGNAL_REF';
    abortId: string;
    aborted: boolean;
}


const GUEST_BRIDGE_SCRIPT = `
await (async function() {
    const pendingRequests = new Map();
    const callbackRegistry = new Map();
    const proxyRefRegistry = new Map();
    const abortControllers = new Map();

    function serializeArg(arg) {
        if (typeof arg === 'function') {
            const id = 'cb_' + Math.random().toString(36).substring(2);
            callbackRegistry.set(id, arg);
            return { __type: 'CALLBACK_REF', id: id };
        }
        if (arg && typeof arg === 'object') {
            const refId = proxyRefRegistry.get(arg);
            if (refId) {
                return { __type: 'REMOTE_REF', id: refId };
            }
        }
        return arg;
    }

    function deserializeResult(val) {
        if (val && typeof val === 'object' && val.__type === 'REMOTE_REF') {
            const proxy = new Proxy({}, {
                get: (target, prop) => {
                    if (prop === 'then') return undefined;
                    if (prop === 'release') {
                        return () => send({ type: 'RELEASE_INSTANCE', id: val.id });
                    }
                    return (...args) => sendRequest('CALL_INSTANCE', {
                        id: val.id,
                        method: prop,
                        args: args
                    });
                }
            });
            // Store the mapping so we can serialize it back
            proxyRefRegistry.set(proxy, val.id);
            return proxy;
        }
        if (val && typeof val === 'object' && val.__type === 'CALLBACK_STREAMS') {
            //specialType, one of
            // - Response
            // - none
            const specialType = val.__specialType;
            if (specialType === 'Response') {
                return new Response(val.value, val.init);
            }
            return val.value;
        }
        return val;
    }

    async function serializeResult(val) {
        if (val instanceof Response) {
            // Use ArrayBuffer instead of ReadableStream body for mobile compatibility
            const buffer = await val.arrayBuffer();
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'Response',
                value: buffer,
                init: {
                    status: val.status,
                    statusText: val.statusText,
                    headers: Array.from(val.headers.entries())
                }
            };
        }
        if (
            val instanceof ReadableStream ||
            val instanceof WritableStream ||
            val instanceof TransformStream
        ) {
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'none',
                value: val
            };
        }
        return val;
    }

    function collectTransferables(obj, transferables = []) {
        if (!obj || typeof obj !== 'object') return transferables;

        if (obj instanceof ArrayBuffer ||
            obj instanceof MessagePort ||
            obj instanceof ImageBitmap ||
            obj instanceof ReadableStream ||
            obj instanceof WritableStream ||
            obj instanceof TransformStream ||
            (typeof OffscreenCanvas !== 'undefined' && obj instanceof OffscreenCanvas)) {
            transferables.push(obj);
        }
        else if (ArrayBuffer.isView(obj) && obj.buffer instanceof ArrayBuffer) {
            transferables.push(obj.buffer);
        }
        else if (Array.isArray(obj)) {
            obj.forEach(item => collectTransferables(item, transferables));
        }
        else if (obj.constructor === Object) {
            Object.values(obj).forEach(value => collectTransferables(value, transferables));
        }

        return transferables;
    }

    function send(payload, transferables = []) {
        window.parent.postMessage(payload, '*', transferables);
    }

    function sendRequest(type, payload) {
        return new Promise((resolve, reject) => {
            const reqId = Math.random().toString(36).substring(7);
            pendingRequests.set(reqId, { resolve, reject });


            if (payload.args) {
                payload.args = payload.args.map(serializeArg);
            }

            const message = { type: type, reqId: reqId, ...payload };
            const transferables = collectTransferables(message);
            send(message, transferables);
        });
    }

    
    
    
    window.addEventListener('message', async (event) => {
        const data = event.data;
        if (!data) return;


        if (data.type === 'RESPONSE' && data.reqId) {
            const req = pendingRequests.get(data.reqId);
            if (req) {
                if (data.error) req.reject(new Error(data.error));
                else req.resolve(deserializeResult(data.result));
                pendingRequests.delete(data.reqId);
            }
        }

        else if (data.type === 'EXECUTE_CODE' && data.reqId) {
            const response = { type: 'EXEC_RESULT', reqId: data.reqId };
            try {
                const result = await eval('(async () => {' + data.code + '})()');
                response.result = result;
            } catch (e) {
                response.error = e.message || String(e);
            }
            send(response);
        }

        else if (data.type === 'ABORT_SIGNAL' && data.abortId) {
            const controller = abortControllers.get(data.abortId);
            if (controller) {
                controller.abort();
                abortControllers.delete(data.abortId);
            }
        }

        else if (data.type === 'INVOKE_CALLBACK' && data.id) {
            const fn = callbackRegistry.get(data.id);
            const response = { type: 'CALLBACK_RETURN', reqId: data.reqId };
            const usedAbortIds = [];

            try {
                if (!fn) throw new Error("Callback not found or released");
                const deserializedArgs = (data.args || []).map(function(a) {
                    if (a && typeof a === 'object' && a.__type === 'ABORT_SIGNAL_REF') {
                        const controller = new AbortController();
                        abortControllers.set(a.abortId, controller);
                        usedAbortIds.push(a.abortId);
                        if (a.aborted) { controller.abort(); }
                        return controller.signal;
                    }
                    return a;
                });
                const result = await fn(...deserializedArgs);
                response.result = await serializeResult(result);
            } catch (e) {
                response.error = e.message || "Guest callback error";
            }
            // Clean up abort controllers after callback completes
            for (const id of usedAbortIds) {
                abortControllers.delete(id);
            }
            const transferables = collectTransferables(response);
            send(response, transferables);
        }
    });





    const propertyCache = new Map();

    window.risuai = new Proxy({}, {
        get: (target, prop) => {
            if (propertyCache.has(prop)) {
                return propertyCache.get(prop);
            }
            return (...args) => sendRequest('CALL_ROOT', { method: prop, args: args });
        }
    });
    window.Risuai = window.risuai;

    // Route external fetches through host-side nativeFetch to avoid browser CORS failures
    // in plugin iframes (notably custom provider endpoints).
    const originalFetch = window.fetch ? window.fetch.bind(window) : null;
    const normalizeHeaders = (sourceHeaders) => {
        const headers = {};
        if (!sourceHeaders) {
            return headers;
        }
        if (sourceHeaders instanceof Headers) {
            sourceHeaders.forEach((value, key) => {
                headers[key] = value;
            });
            return headers;
        }
        if (Array.isArray(sourceHeaders)) {
            for (const pair of sourceHeaders) {
                if (Array.isArray(pair) && pair.length >= 2) {
                    headers[String(pair[0])] = String(pair[1]);
                }
            }
            return headers;
        }
        if (typeof sourceHeaders === 'object') {
            for (const key of Object.keys(sourceHeaders)) {
                headers[key] = String(sourceHeaders[key]);
            }
        }
        return headers;
    };

    const isRequestLike = (value) => {
        return (typeof Request !== 'undefined') && (value instanceof Request);
    };

    window.fetch = async (input, init = {}) => {
        const requestLike = isRequestLike(input) ? input : null;
        let requestUrl = '';
        if (typeof input === 'string') {
            requestUrl = input;
        } else if (input instanceof URL) {
            requestUrl = input.toString();
        } else if (requestLike) {
            requestUrl = requestLike.url;
        } else if (input && typeof input === 'object' && 'url' in input) {
            requestUrl = String(input.url);
        } else {
            requestUrl = String(input);
        }

        const isExternalHttp = /^https?:\\/\\//i.test(requestUrl);
        if (!isExternalHttp) {
            if (originalFetch) {
                return originalFetch(input, init);
            }
            throw new Error('Fetch is not available');
        }

        const method = String(
            init.method ||
            (requestLike ? requestLike.method : undefined) ||
            'GET'
        ).toUpperCase();

        const headers = Object.assign(
            {},
            normalizeHeaders(requestLike ? requestLike.headers : undefined),
            normalizeHeaders(init.headers)
        );

        let body = init.body;
        if (body === undefined && requestLike && method !== 'GET' && method !== 'HEAD') {
            // Preserve payload for fetch(Request) calls so proxied APIs receive full JSON bodies.
            body = await requestLike.clone().arrayBuffer();
        }

        if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
            body = body.toString();
        } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
            body = await body.arrayBuffer();
        } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
            // _fetch only transports string/bytes. Keep browser-native fetch for FormData.
            if (originalFetch) {
                return originalFetch(input, init);
            }
            throw new Error('Fetch is not available');
        }
        return window.risuai._fetch(requestUrl, {
            method,
            headers,
            body,
        });
    };

    try {
        // Initialize cached properties
        const propsToInit = await window.risuai._getPropertiesForInitialization();
        console.log('Initializing risuai properties:', JSON.stringify(propsToInit.list));
        for (let i = 0; i < propsToInit.list.length; i++) {
            const key = propsToInit.list[i];
            const value = propsToInit[key];
            propertyCache.set(key, value);
        }

        // Initialize aliases
        const aliases = await window.risuai._getAliases();
        const aliasKeys = Object.keys(aliases);
        for (let i = 0; i < aliasKeys.length; i++) {
            const aliasKey = aliasKeys[i];
            const childrens = Object.keys(aliases[aliasKey]);
            const aliasObj = {};
            for (let j = 0; j < childrens.length; j++) {
                const childKey = childrens[j];
                aliasObj[childKey] = risuai[aliases[aliasKey][childKey]];
            }
            propertyCache.set(aliasKey, aliasObj);
        }

        // Initialize helper functions defined in the guest

        propertyCache.set('unwarpSafeArray', async (safeArray) => {
            const length = await safeArray.length();
            const result = [];
            for (let i = 0; i < length; i++) {
                const item = await safeArray.at(i);
                result.push(item);
            }
            return result;
        });
    } catch (e) {
        console.error('Failed to initialize risuai properties:', e);
    }

    window.initOldApiGlobal = () => {
        const keys = risuai._getOldKeys()
        for(const key of keys){
            window[key] = risuai[key];
        }
    }
})();
`;

export class SandboxHost {
    private iframe: HTMLIFrameElement;
    private apiFactory: any;
    private nonce = crypto.randomUUID();
    private csp = `connect-src 'none'; script-src 'nonce-${this.nonce}' https:; frame-src 'none'; object-src 'none'; style-src * 'unsafe-inline';`;

    private instanceRegistry = new Map<string, any>();


    private pendingCallbacks = new Map<string, { resolve: Function, reject: Function }>();

    constructor(apiFactory: any) {
        this.apiFactory = apiFactory;
    }

    public executeInIframe(code: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const reqId = 'exec_' + Math.random().toString(36).substring(2);

            const handler = (event: MessageEvent) => {
                if (event.source !== this.iframe.contentWindow) return;
                const data = event.data;

                if (data.type === 'EXEC_RESULT' && data.reqId === reqId) {
                    window.removeEventListener('message', handler);
                    if (data.error) {
                        reject(new Error(data.error));
                    } else {
                        resolve(data.result);
                    }
                }
            };

            window.addEventListener('message', handler);

            this.iframe.contentWindow?.postMessage({
                type: 'EXECUTE_CODE',
                reqId,
                code
            }, '*');
        });
    }

    private collectTransferables(obj: any, transferables: Transferable[] = []): Transferable[] {
        if (!obj || typeof obj !== 'object') return transferables;

        if (obj instanceof ArrayBuffer ||
            obj instanceof MessagePort ||
            obj instanceof ImageBitmap ||
            obj instanceof ReadableStream ||
            obj instanceof WritableStream ||
            obj instanceof TransformStream ||
            (typeof OffscreenCanvas !== 'undefined' && obj instanceof OffscreenCanvas)) {
            transferables.push(obj);
        }
        else if (ArrayBuffer.isView(obj) && obj.buffer instanceof ArrayBuffer) {
            transferables.push(obj.buffer);
        }
        else if (Array.isArray(obj)) {
            obj.forEach(item => this.collectTransferables(item, transferables));
        }
        else if (obj.constructor === Object) {
            Object.values(obj).forEach(value => this.collectTransferables(value, transferables));
        }

        return transferables;
    }


    private async serialize(val: any): Promise<any> {
        if (
            val &&
            (typeof val === 'object' || typeof val === 'function') &&
            val.__classType === 'REMOTE_REQUIRED'
        ) {
            if (val === null) return null;
            if (Array.isArray(val)) return val;


            const id = 'ref_' + Math.random().toString(36).substring(2);
            this.instanceRegistry.set(id, val);
            return { __type: 'REMOTE_REF', id } as RemoteRef;
        }

        if(val instanceof Response) {
            // Use ArrayBuffer instead of ReadableStream body for mobile compatibility
            // (mobile browsers don't support transferring ReadableStream via postMessage)
            const buffer = await val.arrayBuffer();
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'Response',
                value: buffer,
                init: {
                    status: val.status,
                    statusText: val.statusText,
                    headers: Array.from(val.headers.entries())
                }
            };
        }

        if(
            val instanceof ReadableStream
            || val instanceof WritableStream
            || val instanceof TransformStream
        ) {
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'none',
                value: val
            };
        }
        return val;
    }

    private deserializeResult(val: any): any {
        if (val && typeof val === 'object' && val.__type === 'CALLBACK_STREAMS') {
            const specialType = val.__specialType;
            if (specialType === 'Response') {
                return new Response(val.value, val.init);
            }
            return val.value;
        }
        return val;
    }


    private deserializeArgs(args: any[]) {
        return args.map(arg => {
            if (arg && arg.__type === 'CALLBACK_REF') {
                const cbRef = arg as CallbackRef;

                return async (...innerArgs: any[]) => {
                    return new Promise((resolve, reject) => {
                        const reqId = 'cb_req_' + Math.random().toString(36).substring(2);
                        this.pendingCallbacks.set(reqId, { resolve, reject });

                        // AbortSignal cannot be structured-cloned for postMessage.
                        // Convert to a serializable ref and forward abort events
                        // via a separate ABORT_SIGNAL message.
                        const sanitizedArgs = innerArgs.map(arg => {
                            if (arg instanceof AbortSignal) {
                                const abortId = 'abort_' + Math.random().toString(36).substring(2);
                                const ref: AbortSignalRef = {
                                    __type: 'ABORT_SIGNAL_REF',
                                    abortId,
                                    aborted: arg.aborted
                                };
                                if (!arg.aborted) {
                                    arg.addEventListener('abort', () => {
                                        try {
                                            this.iframe.contentWindow?.postMessage({
                                                type: 'ABORT_SIGNAL',
                                                abortId
                                            } as RpcMessage, '*');
                                        } catch (_) { /* iframe already removed */ }
                                    }, { once: true });
                                }
                                return ref;
                            }
                            return arg;
                        });

                        const message = {
                            type: 'INVOKE_CALLBACK',
                            id: cbRef.id,
                            reqId,
                            args: sanitizedArgs
                        };
                        const transferables = this.collectTransferables(message);
                        this.iframe.contentWindow?.postMessage(message, '*', transferables);
                    });
                };
            }
            if (arg && arg.__type === 'REMOTE_REF') {
                const remoteRef = arg as RemoteRef;
                const instance = this.instanceRegistry.get(remoteRef.id);
                if (instance) {
                    return instance;
                }
            }
            return arg;
        });
    }

    public run(container: HTMLElement|HTMLIFrameElement, userCode: string) {
        if(container instanceof HTMLIFrameElement) {
            this.iframe = container;
        } else {
            this.iframe = document.createElement('iframe');
            container.appendChild(this.iframe);
        }

        this.iframe.style.width = "100%";
        this.iframe.style.height = "100%";
        this.iframe.style.border = "none";

        this.iframe.style.backgroundColor = "transparent";
        this.iframe.setAttribute('allowTransparency', 'true');

        this.iframe.sandbox.add('allow-scripts');
        this.iframe.sandbox.add('allow-modals')
        this.iframe.sandbox.add('allow-downloads')

        this.iframe.setAttribute('csp', this.csp);

        const messageHandler = async (event: MessageEvent) => {
            if (event.source !== this.iframe.contentWindow) return;
            const data = event.data as RpcMessage;


            if (data.type === 'CALLBACK_RETURN') {
                const req = this.pendingCallbacks.get(data.reqId!);
                if (req) {
                    if (data.error) req.reject(new Error(data.error));
                    else req.resolve(this.deserializeResult(data.result));
                    this.pendingCallbacks.delete(data.reqId!);
                }
                return;
            }


            if (data.type === 'RELEASE_INSTANCE') {
                this.instanceRegistry.delete(data.id!);
                return;
            }


            if (data.type === 'CALL_ROOT' || data.type === 'CALL_INSTANCE') {
                const response: RpcMessage = { type: 'RESPONSE', reqId: data.reqId };

                try {

                    const args = this.deserializeArgs(data.args || []);
                    let result: any;


                    if (data.type === 'CALL_ROOT') {
                        const fn = this.apiFactory[data.method!];
                        if (typeof fn !== 'function') throw new Error(`API method ${data.method} not found`);
                        result = await fn(...args);
                    } else {
                        const instance = this.instanceRegistry.get(data.id!);
                        if (!instance) throw new Error("Instance not found or released");
                        if (typeof instance[data.method!] !== 'function') throw new Error(`Method ${data.method} missing on instance`);
                        result = await instance[data.method!](...args);
                    }


                    response.result = await this.serialize(result);

                } catch (err: any) {
                    response.error = err.message || "Host execution error";
                }

                const transferables = this.collectTransferables(response);
                try {
                    this.iframe.contentWindow?.postMessage(response, '*', transferables);                    
                } catch (error) {
                    this.iframe.contentWindow?.postMessage({
                        type: 'RESPONSE',
                        reqId: data.reqId,
                        error: 'Failed to post message to iframe: ' + (error as Error).message
                    }, '*');
                    console.error('Failed to post message to iframe:', error);
                }
            }
        };

        window.addEventListener('message', messageHandler);


        const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${this.csp}">
      </head>
      <body>
        <style>
            body {
                background-color: transparent;
            }
        </style>
        <script nonce="${this.nonce}">
            (async () => {
                ${GUEST_BRIDGE_SCRIPT}
                    
                (async () => {
                    ${userCode}
                })()
            })();
        </script>
      </body>
      </html>
    `;

        this.iframe.srcdoc = html;

        return () => {
            window.removeEventListener('message', messageHandler);
            this.iframe.remove();
            this.instanceRegistry.clear();
            this.pendingCallbacks.clear();
        };
    }

    public terminate() {
        if (this.iframe) {
            this.iframe.remove();
        }
        this.instanceRegistry.clear();
        this.pendingCallbacks.clear();
    }
}
