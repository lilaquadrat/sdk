import axios, { AxiosResponse, AxiosRequestConfig, HttpStatusCode } from 'axios';
import { BasicData, Contact, ContactAgreement, Content, Customers, DataObject, List, ListOfModels, ListParticipants, ListPartiticpantsDetails, Location } from '@lilaquadrat/interfaces';
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

let cachedCalls: Record<string, SDKResponse<unknown> & SDKCache> = {};

export default class StudioSDK {

  readonly endpoints = {
    live: {
      api: 'https://api.lilaquadrat.de',
      media: 'https://media.lilaquadrat.de',
    },
    next: {
      api: 'https://next-api.lilaquadrat.de',
      media: 'https://next-media.lilaquadrat.de',
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
  } = { app: '' };

  constructor(options: StudioSDK['options']) {

    if (options.authToken) this.authToken = options.authToken;

    if (options.customEndpoints) this.customEndpoints = options.customEndpoints;

    this.mode = options.customEndpoints ? 'custom' : options.mode || 'live';

    if (options.company) this.company = options.company;

    if (options.project) this.project = options.project;

    this.app = options.app;

    if (options.universalModel) this.universalModel = options.universalModel;

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

    if (call.method === 'GET' && !options?.bypassCache) {

      const cacheHit = StudioSDK.cache<T>(axios.getUri(call), undefined, options);

      if (cacheHit) return Promise.resolve(cacheHit);

    }

    return axios.request(call)
      .then((response) => {

        if (call.method === 'GET') StudioSDK.cache(axios.getUri(call), response, options);

        return response;

      })
      .then((response) => ({ data: response.data, status: response.status }));

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
      join: (listId: string, person: Contact, message: string | undefined, category: string, agreements: ContactAgreement[]) => StudioSDK.handleCall<Customers>(
        {
          method: 'POST',
          url: this.getUrl('api', ['public', 'lists', 'participants', this.company, this.project, listId, 'join']),
          headers: this.getHeaders(),
          data: {
            person,
            agreements,
            message,
            category,
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

    lists: {},
    me: {

      connect: (customerId: string) => StudioSDK.handleCall<any>(
        {
          method: 'PUT',
          url: this.getUrl('api', ['members', 'me', this.company, this.project, 'connect']),
          headers: this.getHeaders(),
          data: { customerId },
        },
      ),

      isConnected: () => StudioSDK.handleCall<any>(
        {
          method: 'HEAD',
          url: this.getUrl('api', ['members', 'me', this.company, this.project, 'connected', this.app]),
          headers: this.getHeaders(),
        },
      ),



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
