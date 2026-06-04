import axios, { AxiosResponse, AxiosRequestConfig, HttpStatusCode } from 'axios';
import { BasicData, Contact, ContactAgreement, Content, CustomerPerson, Customers, DataObject, List, ListOfModels, ListParticipants, ListPartiticpantsDetails, Location, ObjectIdString } from '@lilaquadrat/interfaces';
import { hardCopy } from '@lilaquadrat/studio/lib/esm/frontend';

// const mockJs = {};
// const ISMOCK = false;

export type SDKResponse<T> = {
  data: T
  status: HttpStatusCode
  cacheLifetime?: number
  cacheTime?: number;
  isCache?: boolean
};

export type SDKCache = {
  group?: string
  action?: string
  id?: string
  cacheLifetime?: number
  cacheTime?: number;
};

export type SDKModes = 'live' | 'next' | 'custom';

export type SDKCallOptions = {
  /**
   * ignore the cache and always execute the call
   */
  bypassCache?: boolean
  group?: string,
  action?: string,
  /**
   * if a id is given, use it as key for atomic cache flushing
   *
   * e.g. ``flushId(id)``
   *
   * instead of the whole action category
   *
   * e.g. ``flushCache(group, action)``
   *
   */
  id?: string
  /**
   * in milliseconds
   */
  cacheLifetime?: number
};

export type UploadFile = {
  filename: string
  size: number
  mimetype: string
  data: Blob | ArrayBuffer | Uint8Array
};

export type UploadOptions = {
  list?: ObjectIdString
  thumbnails?: boolean
  overwrite?: boolean
  contentId?: ObjectIdString
  structureInternalId?: ObjectIdString
  moduleUuid?: string
};

export type UploadConfig = {
  chunkSize?: number
  retries?: number
  retryDelay?: number
  concurrency?: number
};

export type UploadProgressPhase =
  | { phase: 'create-upload-start' }
  | { phase: 'create-upload-done', uploadId: string }
  | { phase: 'chunk-start', chunkIndex: number, totalChunks: number }
  | { phase: 'chunk-done', chunkIndex: number, totalChunks: number }
  | { phase: 'done', uploadId: string }
  | { phase: 'error', error: unknown };

export type UploadProgressEvent = UploadProgressPhase & {
  file: UploadFile
  fileIndex?: number
  totalFiles?: number
};

export type UploadProgressCallback = (event: UploadProgressEvent) => void;

export type UploadResult = {
  uploadId: string
  filename: string
};

export type UploadMultipleResult = {
  successCount: number
  failureCount: number
  results: { file: UploadFile, uploadId?: string, error?: unknown }[]
};

let cachedCalls: Record<string, SDKResponse<unknown> & SDKCache> = {};
let inFlightCalls: Record<string, Promise<SDKResponse<unknown>>> = {};

export default class StudioSDK {

  readonly endpoints = {
    live: {
      api: 'https://api.lilaquadrat.studio',
      media: 'https://media.lilaquadrat.studio',
    },
    next: {
      api: 'https://api.lilaquadrat.dev',
      media: 'https://media.lilaquadrat.dev',
    },
  };

  customEndpoints = {
    api: '',
    media: '',
  };

  authToken!: string;

  mode: 'live' | 'next' | 'custom' = 'custom';

  company!: string;

  project!: string;

  app: string;

  universalModel!: string;

  options: {
    app: string,
    company?: string,
    project?: string,
    authToken?: string,
    mode?: SDKModes,
    customEndpoints?: { api: string, media: string }
    universalModel?: string
    upload?: UploadConfig
  } = { app: '' };

  uploadConfig: Required<UploadConfig> = {
    chunkSize: 6 * 1024 * 1024,
    retries: 3,
    retryDelay: 500,
    concurrency: 5,
  };

  static RETRY_STATUS_CODES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

  constructor(options: StudioSDK['options']) {

    if (options.authToken) this.authToken = options.authToken;

    if (options.customEndpoints) this.customEndpoints = options.customEndpoints;

    this.mode = options.customEndpoints ? 'custom' : options.mode || 'live';

    if (options.company) this.company = options.company;

    if (options.project) this.project = options.project;

    this.app = options.app;

    if (options.universalModel) this.universalModel = options.universalModel;

    if (options.upload) this.uploadConfig = { ...this.uploadConfig, ...options.upload };

  }

  static calculateChunks(fileSize: number, chunkSize: number) {

    if (fileSize > chunkSize) return Math.ceil(fileSize / chunkSize);
    return 1;

  }

  static toBlob(data: Blob | ArrayBuffer | Uint8Array): Blob {

    if (data instanceof Blob) return data;
    return new Blob([data as BlobPart]);

  }

  static async batch<T>(items: T[], fn: (item: T, index: number) => Promise<void>, concurrency: number) {

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {

      while (true) {

        const idx = cursor++;
        if (idx >= items.length) break;
        await fn(items[idx], idx);

      }

    });
    await Promise.all(workers);

  }

  private async sleepBackoff(attempt: number) {

    const cap = this.uploadConfig.retryDelay * Math.pow(2, attempt);
    const backoff = Math.random() * cap;
    await new Promise((resolve) => setTimeout(resolve, backoff));

  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.uploadConfig.retries; attempt++) {

      try {

        return await fn();

      } catch (error) {

        lastError = error;
        const status = (error as { response?: { status?: number } })?.response?.status;
        const retryable = !status || StudioSDK.RETRY_STATUS_CODES.has(status);

        if (!retryable || attempt >= this.uploadConfig.retries) throw error;

        await this.sleepBackoff(attempt);

      }

    }

    throw lastError;

  }

  private getUrl(type: 'api' | 'media', methodArray: string[]) {

    const method = methodArray.filter((single) => single);
    const urlArray: string[] = [];
    let useEndpoint: string;

    if (this.mode === 'custom') {

      useEndpoint = this.customEndpoints[type];

    } else {

      useEndpoint = this.endpoints[this.mode][type];

    }

    urlArray.push(useEndpoint);
    urlArray.push(...method);

    return urlArray.filter((single) => single).join('/');

  }

  private getHeaders() {

    const headers: Record<string, string> = {
      'studio-app': this.app,
    };

    if (this.authToken) {

      headers.Authorization = `bearer ${this.authToken}`;

    }

    return headers;

  }

  static getCacheKeyMock(url: string) {

    const key = new URL(url);

    return key.pathname + key.search;

  }

  static getCacheKey(url: string) {

    let key: string = url;

    key = key.replace(/:|\/|\?|=|&/ig, '-');

    return key;

  }

  static getCache() {

    return cachedCalls;

  }

  static handleCall<T, D = unknown>(call: AxiosRequestConfig<D>, options?: SDKCallOptions): Promise<SDKResponse<T>> {

    // if (ISMOCK) {

    //   if (call.method !== 'GET') return Promise.resolve({ data: {} as T, status: 200 });

    //   const key = StudioSDK.getCacheKeyMock(call.url as string);

    //   console.group(`SDK_MOCK_CALL: [${call.method}] ${key}`);

    //   // if url is not in MockJs.ts, error will be thrown
    //   if (!mockJs[key]) {

    //     console.error(key);
    //     console.groupEnd();
    //     throw new Error('MOCK_DATA_MISSING');

    //   }

    //   console.log({ data: mockJs[key].data as T, status: mockJs[key].status });
    //   console.groupEnd();

    //   return Promise.resolve({ data: mockJs[key].data as T, status: mockJs[key].status });

    // }

    const url = axios.getUri(call);

    if (call.method === 'GET' && !options?.bypassCache) {

      const cacheHit = StudioSDK.cache<T>(url, undefined, options);

      if (cacheHit) return Promise.resolve(cacheHit);

      const dedupKey = options?.id ? options.id : StudioSDK.getCacheKey(url);

      const inFlight = inFlightCalls[dedupKey];

      if (inFlight) return inFlight as Promise<SDKResponse<T>>;

    }

    const promise = axios.request(call)
      .then((response) => {

        if (call.method === 'GET') StudioSDK.cache(url, response, options);

        return response;

      })
      .then((response) => ({ data: response.data, status: response.status }));

    if (call.method === 'GET' && !options?.bypassCache) {

      const dedupKey = options?.id ? options.id : StudioSDK.getCacheKey(url);

      inFlightCalls[dedupKey] = promise;

      promise.finally(() => { delete inFlightCalls[dedupKey]; });

    }

    return promise;

  }

  static cache<T>(url: string, response?: AxiosResponse<T>, options?: SDKCallOptions) {

    const key = options?.id ? options.id : StudioSDK.getCacheKey(url);

    if (response) {

      const useKey = options?.id
        ? options.id
        : key;

      cachedCalls[useKey] = {
        data: response.data,
        status: response.status,
        action: options?.action,
        group: options?.group,
        cacheLifetime: options?.cacheLifetime ? Date.now() + (options?.cacheLifetime || 0) : null,
        cacheTime: Date.now(),
      } as SDKResponse<T> & SDKCache;

      return undefined;

    }

    const useCache = cachedCalls[key] as SDKResponse<T> & SDKCache;

    if (!useCache) return null;

    if (useCache.cacheLifetime && useCache.cacheLifetime < Date.now()) {

      console.debug('cache found but lifetime');

      delete cachedCalls[key];
      return null;

    }

    const returnCache = hardCopy(useCache);

    delete returnCache?.action;
    delete returnCache?.group;
    delete returnCache?.id;

    returnCache.isCache = true;

    return returnCache;

  }

  static flushCache(group?: string, action?: string) {

    if (group || action) {

      Object.keys(cachedCalls).forEach((key) => {

        let flush: boolean = false;
        const singleCache = cachedCalls[key];

        if (group && action) {

          if (singleCache.group === group && singleCache.action === action) flush = true;

        } else if (group) {

          if (singleCache.group === group) flush = true;

        } else if (action) {

          if (singleCache.action === action) flush = true;

        }

        if (flush) {

          delete cachedCalls[key];

        }

      });

    } else {

      cachedCalls = {};

    }

  }

  static flushId(id: string) {

    delete cachedCalls[id];

  }

  public = {
    content: {

      fetch: (type: string, link: string, options?: { state?: 'draft' | 'publish' }) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['public', 'content', type, link]),
          headers: this.getHeaders(),
          params: options,
        },
      ),

      search: (type: string, search: string, site: number = 1, options?: { state?: 'draft' | 'publish' }) => {

        const params = { search, ...options };

        return StudioSDK.handleCall<BasicData<Content>>(
          {
            method: 'GET',
            url: this.getUrl('api', ['public', 'content', type, 'search', site.toString()]),
            headers: this.getHeaders(),
            params,
          },
        );

      },

      predefined: (id: string) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['public', 'content', 'lilaquadrat', 'studio', id]),
          headers: this.getHeaders(),
        },
        {
          group: 'editor',
          action: 'single',
          id,
        },
      ),

      predefinedLatest: (categories: string[]) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['public', 'content', 'lilaquadrat', 'studio', 'latest']),
          headers: this.getHeaders(),
          params: {
            category: categories,
          },
        },
        {
          group: 'editor',
          action: 'single',
        },
      ),

      getById: (id: string) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['public', 'content', this.company, this.project, id]),
          headers: this.getHeaders(),
        },
        {
          group: 'editor',
          action: 'single',
          id,
        },
      ),

      getByFilename: (filename: string) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['public', 'content', this.company, this.project, 'filename']),
          headers: this.getHeaders(),
          params: {
            filename
          }
        },
        {
          group: 'editor',
          action: 'single',
          id: filename,
        },
      ),

      getByInternalId: (id: string) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['public', 'content', this.company, this.project, 'internal', id]),
          headers: this.getHeaders(),
        },
        {
          group: 'editor',
          action: 'single',
          id,
        },
      ),

    },

    lists: {
      join: (listId: string, person: Contact, message: string | undefined, category: string, agreements: ContactAgreement[], structure: Record<string, string> | undefined, options: {uuid: ObjectIdString, parentId: string}) => StudioSDK.handleCall<{_id: string, id: string}>(
        {
          method: 'POST',
          url: this.getUrl('api', ['public', 'lists', 'participants', this.company, this.project, listId, 'join']),
          headers: this.getHeaders(),
          data: {
            person,
            agreements,
            message,
            category,
            structure,
            options,
          },
        },
      ),
      address: (address: string) => StudioSDK.handleCall<ListOfModels<Location>>(
        {
          method: 'get',
          url: this.getUrl('api', ['public', 'lists', 'participants', this.company, this.project, 'address']),
          headers: this.getHeaders(),
          params: {
            address,
          },
        },
      ),
      state: (listId: string) => StudioSDK.handleCall<ListPartiticpantsDetails>(
        {
          method: 'get',
          url: this.getUrl('api', ['public', 'lists', this.company, this.project, listId, 'state']),
          headers: this.getHeaders(),
        },
      ),
    },

    carts: {
      create:(cart?: {attributes: Record<string, string>}) => StudioSDK.handleCall<any>(
        {
          method: 'POST',
          url: this.getUrl('api', ['public', 'carts', this.company, this.project]),
          headers: this.getHeaders(),
          data: cart,
        },
      ),
      update:(internalId: ObjectIdString, items: any) => StudioSDK.handleCall<any>(
        {
          method: 'PUT',
          url: this.getUrl('api', ['public', 'carts', this.company, this.project, internalId]),
          headers: this.getHeaders(),
          data: items,
        },
      ),
      getById:(internalId: ObjectIdString) => StudioSDK.handleCall<any>(
        {
          method: 'GET',
          url: this.getUrl('api', ['public', 'carts', this.company, this.project, internalId]),
          headers: this.getHeaders(),
        },
      ),
      getFinishedById:(internalId: ObjectIdString) => StudioSDK.handleCall<any>(
        {
          method: 'GET',
          url: this.getUrl('api', ['public', 'carts', this.company, this.project, 'finished', internalId]),
          headers: this.getHeaders(),
        },
      ),
      getProduct:(id: string) => StudioSDK.handleCall<any>(
        {
          method: 'GET',
          url: this.getUrl('api', ['public', 'carts', this.company, this.project, 'product', id]),
          headers: this.getHeaders(),
        },
      ),
      finalize:(internalId: ObjectIdString) => StudioSDK.handleCall<any>(
        {
          method: 'PUT',
          url: this.getUrl('api', ['public', 'carts', this.company, this.project, 'finalize', internalId]),
          headers: this.getHeaders(),
        },
      ),
    }
  };

  members = {
    content: {

      fetch: (type: string, link: string, options?: { state?: 'draft' | 'publish' }) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['members', 'content', type, link]),
          headers: this.getHeaders(),
          params: options,
        },
      ),

      search: (type: string, search: string, site: number = 1, options?: { state?: 'draft' | 'publish' }) => {

        const params = { search, ...options };

        return StudioSDK.handleCall<BasicData<Content>>(
          {
            method: 'GET',
            url: this.getUrl('api', ['members', 'content', type, 'search', site.toString()]),
            headers: this.getHeaders(),
            params,
          },
        );

      },

      getById: (id: string) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['members', 'content', this.company, this.project, id]),
          headers: this.getHeaders(),
        },
        {
          group: 'editor',
          action: 'single',
          id,
        },
      ),


      getByFilename: (filename: string) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['members', 'content', this.company, this.project, 'filename']),
          headers: this.getHeaders(),
          params: {
            filename
          }
        },
        {
          group: 'editor',
          action: 'single',
          id: filename,
        },
      ),


      getByInternalId: (id: string) => StudioSDK.handleCall<BasicData<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['members', 'content', this.company, this.project, 'internal', id]),
          headers: this.getHeaders(),
        },
        {
          group: 'editor',
          action: 'single',
          id,
        },
      ),

    },

    lists: {

      join: (listId: string, message: string | undefined, category: string, agreements: ContactAgreement[], structure: Record<string, string> | undefined, options: {uuid: ObjectIdString, parentId: string}) => StudioSDK.handleCall<string>(
        {
          method: 'POST',
          url: this.getUrl('api', ['members', 'lists', 'participants', this.company, this.project, listId, 'join']),
          headers: this.getHeaders(),
          data: {
            agreements,
            message,
            category,
            structure,
            options,
          },
        },
      ),

      /**
       * get the state for the logged in used for a specific list
       */
      state: (listId: string) => StudioSDK.handleCall<ListParticipants>(
        {
          method: 'GET',
          url: this.getUrl('api', ['members', 'lists', this.company, this.project, listId]),
          headers: this.getHeaders(),
        },
        {
          group: 'lists',
          action: 'state',
          id: listId,
        },
      ),

    },

    me: {

      connect: (customerId: string) => StudioSDK.handleCall<any>(
        {
          method: 'PUT',
          url: this.getUrl('api', ['members', 'me', this.company, this.project, 'connect']),
          headers: this.getHeaders(),
          data: { customerId },
        },
      ),

      confirmEmail: (confirmationCode: string) => StudioSDK.handleCall<any>(
        {
          method: 'PUT',
          url: this.getUrl('api', ['members', 'me', this.company, this.project, 'confirm']),
          headers: this.getHeaders(),
          data: { confirmationCode },
        },
      ),

      resendConfirmationMail: () => StudioSDK.handleCall<any>(
        {
          method: 'POST',
          url: this.getUrl('api', ['members', 'me', this.company, this.project, 'resendConfirmationMail']),
          headers: this.getHeaders(),
        },
      ),

      get: () => StudioSDK.handleCall<CustomerPerson>(
        {
          method: 'GET',
          url: this.getUrl('api', ['members', 'me', this.company, this.project]),
          headers: this.getHeaders(),
        },
        {
          group: 'me',
          action: 'get',
        },
      ),

      isConnected: () => StudioSDK.handleCall<any>(
        {
          method: 'HEAD',
          url: this.getUrl('api', ['members', 'me', this.company, this.project, 'connected', this.app]),
          headers: this.getHeaders(),
        },
      ),

      emailConfirmed: () => StudioSDK.handleCall<any>(
        {
          method: 'HEAD',
          url: this.getUrl('api', ['members', 'me', this.company, this.project, 'emailConfirmed', this.app]),
          headers: this.getHeaders(),
        },
      ),



    },

    storage: {

      listProject: (bucket: string, site: number = 1, options?: { assetId?: string[] }) => StudioSDK.handleCall<DataObject<any>>(
        {
          method: 'GET',
          url: this.getUrl('media', ['members', bucket, this.company, this.project, 'list', site.toString()]),
          headers: this.getHeaders(),
          params: options,
        },
        {
          group: 'storage',
          action: 'listProject',
        },
      ),

      listCompany: (bucket: string, site: number = 1, options?: { assetId?: string[] }) => StudioSDK.handleCall<DataObject<any>>(
        {
          method: 'GET',
          url: this.getUrl('media', ['members', bucket, this.company, 'list', site.toString()]),
          headers: this.getHeaders(),
          params: options,
        },
        {
          group: 'storage',
          action: 'listCompany',
        },
      ),

      remove: (bucket: string, internalId: ObjectIdString) => {
        const path = bucket === 'customers'
          ? ['members', bucket, this.company, internalId]
          : ['members', bucket, this.company, this.project, internalId];

        return StudioSDK.handleCall<any>(
          {
            method: 'DELETE',
            url: this.getUrl('media', path),
            headers: this.getHeaders(),
          },
        );
      },

      token: (bucket: string, scope: 'company' | 'project') => StudioSDK.handleCall<{token: string, expiresIn: number, createdAt: number, expiresAt: number}>(
        {
          method: 'GET',
          url: this.getUrl('media', ['members', bucket, this.company, ...(scope === 'project' ? [this.project] : []), 'token']),
          headers: this.getHeaders(),
        },
      ),

      createUpload: (payload: {
        filename: string,
        size: number,
        mimetype: string,
        chunks: number,
        list?: ObjectIdString,
        options?: UploadOptions,
      }, bucket: string) => {
        
        return StudioSDK.handleCall<string>(
          {
            method: 'POST',
            url: this.getUrl('media', ['members', bucket, this.company, this.project, 'upload']),
            headers: this.getHeaders(),
            data: payload,
          },
        );
      },

      uploadChunk: (uploadId: string, bucket: string, chunkIndex: number, chunk: Blob) => this.withRetry(async () => {

        const form = new FormData();
        form.append('file', chunk);
        form.append('index', chunkIndex.toString());

        const response = await axios.request({
          method: 'POST',
          url: this.getUrl('media', ['members', bucket, this.company, this.project, uploadId]),
          headers: this.getHeaders(),
          data: form,
        });

        return { data: response.data, status: response.status } as SDKResponse<unknown>;

      }),

      upload: async (file: UploadFile, bucket: string, options: UploadOptions = {}, onProgress?: UploadProgressCallback): Promise<UploadResult> => {

        const emit = (phase: UploadProgressPhase) => onProgress?.({ ...phase, file });
        const totalChunks = StudioSDK.calculateChunks(file.size, this.uploadConfig.chunkSize);

        emit({ phase: 'create-upload-start' });

        let uploadId: string;

        try {

          const { list, thumbnails, overwrite, contentId, structureInternalId, moduleUuid } = options;
          const createRes = await this.members.storage.createUpload({
            filename: file.filename,
            size: file.size,
            mimetype: file.mimetype,
            chunks: totalChunks,
            list,
            options: { thumbnails, overwrite, contentId, structureInternalId, moduleUuid },
          },
          bucket);
          uploadId = createRes.data;

        } catch (error) {

          emit({ phase: 'error', error });
          throw error;

        }

        emit({ phase: 'create-upload-done', uploadId });

        const blob = StudioSDK.toBlob(file.data);

        for (let i = 0; i < totalChunks; i++) {

          const start = i * this.uploadConfig.chunkSize;
          const end = Math.min(start + this.uploadConfig.chunkSize, blob.size);
          const chunk = blob.slice(start, end);

          emit({ phase: 'chunk-start', chunkIndex: i, totalChunks });

          try {

            await this.members.storage.uploadChunk(uploadId, bucket, i, chunk);

          } catch (error) {

            emit({ phase: 'error', error });
            throw error;

          }

          emit({ phase: 'chunk-done', chunkIndex: i, totalChunks });

        }

        emit({ phase: 'done', uploadId });

        return { uploadId, filename: file.filename };

      },

      uploadMultiple: async (files: UploadFile[], bucket: string, options: UploadOptions = {}, onProgress?: UploadProgressCallback): Promise<UploadMultipleResult> => {

        const totalFiles = files.length;
        const results: UploadMultipleResult['results'] = [];
        let successCount = 0;
        let failureCount = 0;

        await StudioSDK.batch(
          files,
          async (file, index) => {

            const wrapped: UploadProgressCallback | undefined = onProgress
              ? (event) => onProgress({ ...event, fileIndex: index, totalFiles })
              : undefined;

            try {

              const result = await this.members.storage.upload(file, bucket, options, wrapped);
              results[index] = { file, uploadId: result.uploadId };
              successCount++;

            } catch (error) {

              results[index] = { file, error };
              failureCount++;

            }

          },
          this.uploadConfig.concurrency,
        );

        return { successCount, failureCount, results };

      },

    }
  };


  editor = {
    getById: (id: string) => StudioSDK.handleCall<Content>(
      {
        method: 'GET',
        url: this.getUrl('api', ['editor', this.company, this.project, id]),
        headers: this.getHeaders(),
      },
      {
        group: 'editor',
        action: 'single',
        id,
      },
    ),

    getByInternalId: (id: string) => StudioSDK.handleCall<Content>(
      {
        method: 'GET',
        url: this.getUrl('api', ['editor', this.company, this.project, 'internal', id]),
        headers: this.getHeaders(),
      },
      {
        group: 'editor',
        action: 'single',
        id,
      },
    ),


    settings: (data: { company: string, project: string }) => StudioSDK.handleCall<Content>(
      {
        method: 'GET',
        url: this.getUrl('api', ['editor', data.company, data.project, 'settings']),
        headers: this.getHeaders(),
      },
      {
        group: 'editor',
        action: 'settings',
      },
    ),

    list: (site: number = 0, sort?: string, order?: number, options?: { layout?: boolean, partial?: boolean, active?: boolean, search?: string, tags?: string[] }) => {

      const params = {
        sort,
        order,
        ...(options || {}),
      };

      return StudioSDK.handleCall<ListOfModels<Content>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['editor', this.company, this.project, 'list', site.toString()]),
          headers: this.getHeaders(),
          params,
        },
        {
          group: 'editor',
          action: 'list',
        },
      );

    },
  };

  health = {

    health: () => StudioSDK.handleCall<void>(
      {
        method: 'GET',
        url: this.getUrl('api', ['health']),
        headers: this.getHeaders(),
      },
    ),

  };

  customers = {

    list: (site: number = 0, search?: string, tags?: string[], type?: string, sort?: number, order?: string) => StudioSDK.handleCall<DataObject<Customers>>(
      {
        method: 'GET',
        url: this.getUrl('api', ['customers', this.company, this.project, 'list', site.toString()]),
        headers: this.getHeaders(),
        params: {
          search,
          tags,
          sort,
          order,
          type,
        },
      },
      {
        group: 'customers',
        action: 'list',
      },
    ),

    single: (id: string) => StudioSDK.handleCall<Customers>(
      {
        method: 'GET',
        url: this.getUrl('api', ['customers', this.company, this.project, id]),
        headers: this.getHeaders(),
      },
      {
        group: 'customers',
        action: 'single',
        id,
      },
    ),

    tags: (search: string) => StudioSDK.handleCall<string[]>(
      {
        method: 'GET',
        url: this.getUrl('api', ['customers', this.company, this.project, 'tags', search]),
        headers: this.getHeaders(),
      },
      {
        group: 'customers',
        action: 'tags',
      },
    ),

    update: (id: string, data: Customers) => StudioSDK.handleCall<Customers>(
      {
        method: 'PUT',
        url: this.getUrl('api', ['customers', this.company, this.project, id]),
        headers: this.getHeaders(),
        data,
      },
    ),

    add: (data: Customers) => StudioSDK.handleCall<Customers>(
      {
        method: 'POST',
        url: this.getUrl('api', ['customers', this.company, this.project]),
        headers: this.getHeaders(),
        data,
      },
    ),

    remove: (id: string) => StudioSDK.handleCall<Customers>(
      {
        method: 'DELETE',
        url: this.getUrl('api', ['customers', this.company, this.project, id]),
        headers: this.getHeaders(),
      },
    ),

  };

  lists = {

    single: (id: string) => StudioSDK.handleCall<List>(
      {
        method: 'GET',
        url: this.getUrl('api', ['lists', this.company, this.project, id]),
        headers: this.getHeaders(),
      },
      {
        group: 'lists',
        action: 'single',
        id,
      },
    ),

    add: (data: List) => StudioSDK.handleCall<List>(
      {
        method: 'POST',
        url: this.getUrl('api', ['lists', this.company, this.project]),
        headers: this.getHeaders(),
        data,
      },
    ),

    update: (id: string, data: List) => StudioSDK.handleCall<List>(
      {
        method: 'PUT',
        url: this.getUrl('api', ['lists', this.company, this.project, id]),
        headers: this.getHeaders(),
        data,
      },
    ),

    remove: (id: string) => StudioSDK.handleCall<List>(
      {
        method: 'DELETE',
        url: this.getUrl('api', ['lists', this.company, this.project, id]),
        headers: this.getHeaders(),
      },
    ),

    getByInternalId: (id: string) => StudioSDK.handleCall<List>(
      {
        method: 'GET',
        url: this.getUrl('api', ['lists', this.company, this.project, id]),
        headers: this.getHeaders(),
      },
      {
        group: 'lists',
        action: 'single',
        id,
      },
    ),

    list: (site: number = 0, search?: string, tags?: string[], state?: string, sort?: string, order?: number) => StudioSDK.handleCall<DataObject<List[]>>(
      {
        method: 'GET',
        url: this.getUrl('api', ['lists', this.company, this.project, 'list', site.toString()]),
        headers: this.getHeaders(),
        params: {
          search,
          tags,
          sort,
          order,
          state,
        },
      },
      {
        group: 'lists',
        action: 'list',
      },
    ),

    participants: {

      single: (listId: string, id: string) => StudioSDK.handleCall<ListParticipants>(
        {
          method: 'GET',
          url: this.getUrl('api', ['lists', 'participants', this.company, this.project, listId, id]),
          headers: this.getHeaders(),
        },
        {
          group: 'listParticipants',
          action: 'single',
          id,
        },
      ),

      udpateState: (listId: string, id: string, state: ListParticipants['state']) => StudioSDK.handleCall<ListParticipants>(
        {
          method: 'PUT',
          url: this.getUrl('api', ['lists', 'participants', this.company, this.project, listId, 'state', id]),
          headers: this.getHeaders(),
          data: { state },
        },
        {
          group: 'listParticipants',
          action: 'single',
          id,
        },
      ),

      udpateNote: (listId: string, id: string, note: ListParticipants['note']) => StudioSDK.handleCall<ListParticipants>(
        {
          method: 'PUT',
          url: this.getUrl('api', ['lists', 'participants', this.company, this.project, listId, 'note', id]),
          headers: this.getHeaders(),
          data: { note },
        },
        {
          group: 'listParticipants',
          action: 'single',
          id,
        },
      ),

      remove: (listId: string, id: string) => StudioSDK.handleCall<ListParticipants>(
        {
          method: 'DELETE',
          url: this.getUrl('api', ['lists', 'participants', this.company, this.project, listId, id]),
          headers: this.getHeaders(),
        },
      ),

      list: (listId: string, site: number = 0, search?: string, tags?: string[], state?: string[], sort?: string, order?: number) => StudioSDK.handleCall<DataObject<ListParticipants>>(
        {
          method: 'GET',
          url: this.getUrl('api', ['lists', 'participants', this.company, this.project, listId, 'list', site.toString()]),
          headers: this.getHeaders(),
          params: {
            search,
            tags,
            sort,
            order,
            state,
          },
        },
        {
          group: 'listParticipants',
          action: 'list',
        },
      ),

    },
  };

}
