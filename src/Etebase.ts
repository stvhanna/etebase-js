import URI from "urijs";

import * as Constants from "./Constants";

import { deriveKey, sodium, concatArrayBuffers, AsymmetricCryptoManager, ready } from "./Crypto";
export { deriveKey, ready } from "./Crypto";
export * from "./Exceptions";
import { base62, base64, fromBase64, toBase64 } from "./Helpers";
export { base62, base64, fromBase64, toBase64 } from "./Helpers";

import {
  CollectionAccessLevel,
  CollectionCryptoManager,
  CollectionItemCryptoManager,
  CollectionMetadata,
  CollectionItemMetadata,
  EncryptedCollection,
  EncryptedCollectionItem,
  getMainCryptoManager,
  SignedInvitationRead,
} from "./EncryptedModels";
export * from "./EncryptedModels"; // FIXME: cherry-pick what we export
import {
  Authenticator,
  CollectionManagerOnline,
  CollectionItemManagerOnline,
  CollectionInvitationManagerOnline,
  CollectionMemberManagerOnline,
  FetchOptions,
  ItemFetchOptions,
  LoginResponseUser,
  User,
  UserProfile,
} from "./OnlineManagers";
export { User, FetchOptions, ItemFetchOptions } from "./OnlineManagers";

export { CURRENT_VERSION } from "./Constants";

export interface AccountData {
  version: number;
  key: base64;
  user: LoginResponseUser;
  serverUrl: string;
  authToken?: string;
}

export class Account {
  private static readonly CURRENT_VERSION = 1;

  private mainKey: Uint8Array;
  private version: number;
  public user: LoginResponseUser;
  public serverUrl: string;
  public authToken: string | null;

  private constructor(mainEncryptionKey: Uint8Array, version: number) {
    this.mainKey = mainEncryptionKey;
    this.version = version;
    this.authToken = null;
  }

  public static async signup(user: User, password: string, serverUrl?: string) {
    await ready;

    serverUrl = serverUrl ?? Constants.SERVER_URL;
    const authenticator = new Authenticator(serverUrl);
    const version = this.CURRENT_VERSION;
    const salt = sodium.randombytes_buf(32);

    const mainKey = deriveKey(salt, password);
    const mainCryptoManager = getMainCryptoManager(mainKey, version);
    const loginCryptoManager = mainCryptoManager.getLoginCryptoManager();

    const identityCryptoManager = AsymmetricCryptoManager.keygen();

    const accountKey = sodium.crypto_aead_chacha20poly1305_ietf_keygen();
    const encryptedContent = mainCryptoManager.encrypt(concatArrayBuffers(accountKey, identityCryptoManager.privkey));

    const loginResponse = await authenticator.signup(user, salt, loginCryptoManager.pubkey, identityCryptoManager.pubkey, encryptedContent);

    const ret = new this(mainKey, version);

    ret.user = loginResponse.user;
    ret.authToken = loginResponse.token;
    ret.serverUrl = serverUrl;

    return ret;
  }

  public static async login(username: string, password: string, serverUrl?: string) {
    await ready;

    serverUrl = serverUrl ?? Constants.SERVER_URL;
    const authenticator = new Authenticator(serverUrl);
    const loginChallenge = await authenticator.getLoginChallenge(username);

    const mainKey = deriveKey(fromBase64(loginChallenge.salt), password);
    const mainCryptoManager = getMainCryptoManager(mainKey, loginChallenge.version);
    const loginCryptoManager = mainCryptoManager.getLoginCryptoManager();

    const response = JSON.stringify({
      username,
      challenge: loginChallenge.challenge,
      host: URI(serverUrl).host(),
      action: "login",
    });

    const loginResponse = await authenticator.login(response, loginCryptoManager.signDetached(sodium.from_string(response)));

    const ret = new this(mainKey, loginChallenge.version);

    ret.user = loginResponse.user;
    ret.authToken = loginResponse.token;
    ret.serverUrl = serverUrl;

    return ret;
  }

  public async fetchToken() {
    const serverUrl = this.serverUrl;
    const authenticator = new Authenticator(serverUrl);
    const username = this.user.username;
    const loginChallenge = await authenticator.getLoginChallenge(username);

    const mainKey = this.mainKey;
    const mainCryptoManager = getMainCryptoManager(mainKey, loginChallenge.version);
    const loginCryptoManager = mainCryptoManager.getLoginCryptoManager();

    const response = JSON.stringify({
      username,
      challenge: loginChallenge.challenge,
      host: URI(serverUrl).host(),
      action: "login",
    });

    const loginResponse = await authenticator.login(response, loginCryptoManager.signDetached(sodium.from_string(response)));

    this.authToken = loginResponse.token;
  }

  public async logout() {
    const authenticator = new Authenticator(this.serverUrl);

    authenticator.logout(this.authToken!);
    this.version = -1;
    this.mainKey = new Uint8Array();
    this.authToken = null;
  }

  public async changePassword(password: string) {
    const authenticator = new Authenticator(this.serverUrl);
    const username = this.user.username;
    const loginChallenge = await authenticator.getLoginChallenge(username);

    const oldMainCryptoManager = getMainCryptoManager(this.mainKey, this.version);
    const content = oldMainCryptoManager.decrypt(fromBase64(this.user.encryptedContent));

    const mainKey = deriveKey(fromBase64(loginChallenge.salt), password);
    const mainCryptoManager = getMainCryptoManager(mainKey, this.version);
    const loginCryptoManager = mainCryptoManager.getLoginCryptoManager();

    const encryptedContent = mainCryptoManager.encrypt(content);

    await authenticator.changePassword(this.authToken!, loginCryptoManager.pubkey, encryptedContent);

    this.mainKey = mainKey;
    this.user.encryptedContent = toBase64(encryptedContent);
  }

  public save(): AccountData {
    const ret: AccountData = {
      user: this.user,
      authToken: this.authToken!!,
      serverUrl: this.serverUrl,
      version: this.version,
      key: toBase64(this.mainKey),
    };

    return ret;
  }

  public static async load(accountData: AccountData) {
    await ready;

    const ret = new this(fromBase64(accountData.key), accountData.version);
    ret.user = accountData.user;
    ret.authToken = accountData.authToken ?? null;
    ret.serverUrl = accountData.serverUrl;

    return ret;
  }

  public getCollectionManager() {
    return new CollectionManager(this);
  }

  public _getCryptoManager() {
    // FIXME: cache this
    const mainCryptoManager = getMainCryptoManager(this.mainKey, this.version);
    const content = mainCryptoManager.decrypt(fromBase64(this.user.encryptedContent));
    return mainCryptoManager.getAccountCryptoManager(content.subarray(0, sodium.crypto_aead_chacha20poly1305_ietf_KEYBYTES));
  }

  public _getIdentityCryptoManager() {
    // FIXME: cache this
    const mainCryptoManager = getMainCryptoManager(this.mainKey, this.version);
    const content = mainCryptoManager.decrypt(fromBase64(this.user.encryptedContent));
    return mainCryptoManager.getIdentityCryptoManager(content.subarray(sodium.crypto_aead_chacha20poly1305_ietf_KEYBYTES));
  }
}

export class CollectionManager {
  private readonly etebase: Account;
  private readonly onlineManager: CollectionManagerOnline;

  constructor(etebase: Account) {
    this.etebase = etebase;
    this.onlineManager = new CollectionManagerOnline(this.etebase);
  }

  public async create(meta: CollectionMetadata, content: Uint8Array | string): Promise<Collection> {
    const uintcontent = (content instanceof Uint8Array) ? content : sodium.from_string(content);
    const mainCryptoManager = this.etebase._getCryptoManager();
    const encryptedCollection = await EncryptedCollection.create(mainCryptoManager, meta, uintcontent);
    return new Collection(encryptedCollection.getCryptoManager(mainCryptoManager), encryptedCollection);
  }

  public async fetch(colUid: base62, options?: FetchOptions) {
    const mainCryptoManager = this.etebase._getCryptoManager();
    const encryptedCollection = await this.onlineManager.fetch(colUid, options);
    return new Collection(encryptedCollection.getCryptoManager(mainCryptoManager), encryptedCollection);
  }

  public async list(options?: FetchOptions) {
    const mainCryptoManager = this.etebase._getCryptoManager();
    const ret = await this.onlineManager.list(options);
    return {
      ...ret,
      data: ret.data.map((x) => new Collection(x.getCryptoManager(mainCryptoManager), x)),
    };
  }

  public async upload(collection: Collection, options?: FetchOptions) {
    const col = collection.encryptedCollection;
    // If we have a etag, it means we previously fetched it.
    if (col.etag) {
      await this.onlineManager.update(col, options);
    } else {
      await this.onlineManager.create(col, options);
    }
    col.__markSaved();
  }

  public async transaction(collection: Collection, options?: FetchOptions) {
    const col = collection.encryptedCollection;
    // If we have a etag, it means we previously fetched it.
    if (col.etag) {
      await this.onlineManager.update(col, { ...options, stoken: col.stoken });
    } else {
      await this.onlineManager.create(col, { ...options, stoken: col.stoken });
    }
    col.__markSaved();
  }

  public getItemManager(col: Collection) {
    return new CollectionItemManager(this.etebase, this, col.encryptedCollection);
  }
}

export class CollectionItemManager {
  private readonly etebase: Account;
  private readonly collectionCryptoManager: CollectionCryptoManager;
  private readonly onlineManager: CollectionItemManagerOnline;

  constructor(etebase: Account, _collectionManager: CollectionManager, col: EncryptedCollection) {
    this.etebase = etebase;
    this.collectionCryptoManager = col.getCryptoManager(this.etebase._getCryptoManager());
    this.onlineManager = new CollectionItemManagerOnline(this.etebase, col);
  }

  public async create(meta: CollectionItemMetadata, content: Uint8Array | string): Promise<CollectionItem> {
    const uintcontent = (content instanceof Uint8Array) ? content : sodium.from_string(content);
    const encryptedItem = await EncryptedCollectionItem.create(this.collectionCryptoManager, meta, uintcontent);
    return new CollectionItem(encryptedItem.getCryptoManager(this.collectionCryptoManager), encryptedItem);
  }

  public async fetch(itemUid: base62, options?: ItemFetchOptions) {
    const encryptedItem = await this.onlineManager.fetch(itemUid, options);
    return new CollectionItem(encryptedItem.getCryptoManager(this.collectionCryptoManager), encryptedItem);
  }

  public async list(options?: ItemFetchOptions) {
    const ret = await this.onlineManager.list(options);
    return {
      ...ret,
      data: ret.data.map((x) => new CollectionItem(x.getCryptoManager(this.collectionCryptoManager), x)),
    };
  }

  public async fetchUpdates(items: CollectionItem[], options?: ItemFetchOptions) {
    const ret = await this.onlineManager.fetchUpdates(items.map((x) => x.encryptedItem), options);
    return {
      ...ret,
      data: ret.data.map((x) => new CollectionItem(x.getCryptoManager(this.collectionCryptoManager), x)),
    };
  }

  public async batch(items: CollectionItem[], deps?: CollectionItem[] | null, options?: ItemFetchOptions) {
    await this.onlineManager.batch(items.map((x) => x.encryptedItem), deps?.map((x) => x.encryptedItem), options);
    items.forEach((item) => {
      item.encryptedItem.__markSaved();
    });
  }

  public async transaction(items: CollectionItem[], deps?: CollectionItem[] | null, options?: ItemFetchOptions) {
    await this.onlineManager.transaction(items.map((x) => x.encryptedItem), deps?.map((x) => x.encryptedItem), options);
    items.forEach((item) => {
      item.encryptedItem.__markSaved();
    });
  }
}

export class CollectionInvitationManager {
  private readonly etebase: Account;
  private readonly onlineManager: CollectionInvitationManagerOnline;

  constructor(etebase: Account) {
    this.etebase = etebase;
    this.onlineManager = new CollectionInvitationManagerOnline(this.etebase);
  }

  public async listIncoming() {
    return this.onlineManager.listIncoming();
  }

  public async accept(invitation: SignedInvitationRead) {
    const mainCryptoManager = this.etebase._getCryptoManager();
    const identCryptoManager = this.etebase._getIdentityCryptoManager();
    const encryptionKey = identCryptoManager.decryptVerify(fromBase64(invitation.signedEncryptionKey), fromBase64(invitation.fromPubkey));
    const encryptedEncryptionKey = mainCryptoManager.encrypt(encryptionKey);
    return this.onlineManager.accept(invitation, encryptedEncryptionKey);
  }

  public async reject(invitation: SignedInvitationRead) {
    return this.onlineManager.reject(invitation);
  }

  public async fetchUserProfile(username: string): Promise<UserProfile> {
    return this.onlineManager.fetchUserProfile(username);
  }

  public async invite(col: Collection, username: string, pubkey: base64, accessLevel: CollectionAccessLevel): Promise<void> {
    const mainCryptoManager = this.etebase._getCryptoManager();
    const identCryptoManager = this.etebase._getIdentityCryptoManager();
    const invitation = await col.encryptedCollection.createInvitation(mainCryptoManager, identCryptoManager, username, fromBase64(pubkey), accessLevel);
    await this.onlineManager.invite(invitation);
  }
}

export class CollectionMemberManager {
  private readonly etebase: Account;
  private readonly onlineManager: CollectionMemberManagerOnline;

  constructor(etebase: Account, _collectionManager: CollectionManager, col: Collection) {
    this.etebase = etebase;
    this.onlineManager = new CollectionMemberManagerOnline(this.etebase, col.encryptedCollection);
  }

  public async list() {
    return this.onlineManager.list();
  }

  public async remove(username: string) {
    return this.onlineManager.remove(username);
  }

  public async leave() {
    return this.onlineManager.leave();
  }

  public async modifyAccessLevel(username: string, accessLevel: CollectionAccessLevel) {
    return this.onlineManager.modifyAccessLevel(username, accessLevel);
  }
}

export enum OutputFormat {
  Uint8Array,
  String,
}

export class Collection {
  private readonly cryptoManager: CollectionCryptoManager;
  public readonly encryptedCollection: EncryptedCollection;

  public constructor(cryptoManager: CollectionCryptoManager, encryptedCollection: EncryptedCollection) {
    this.cryptoManager = cryptoManager;
    this.encryptedCollection = encryptedCollection;
  }

  public async verify() {
    return this.encryptedCollection.verify(this.cryptoManager);
  }

  public async setMeta(meta: CollectionMetadata): Promise<void> {
    await this.encryptedCollection.setMeta(this.cryptoManager, meta);
  }

  public async getMeta(): Promise<CollectionMetadata> {
    return this.encryptedCollection.decryptMeta(this.cryptoManager);
  }

  public async setContent(content: Uint8Array | string): Promise<void> {
    const uintcontent = (content instanceof Uint8Array) ? content : sodium.from_string(content);
    await this.encryptedCollection.setContent(this.cryptoManager, uintcontent);
  }

  public async getContent(outputFormat?: OutputFormat.Uint8Array): Promise<Uint8Array>;
  public async getContent(outputFormat?: OutputFormat.String): Promise<string>;
  public async getContent(outputFormat: OutputFormat = OutputFormat.Uint8Array): Promise<any> {
    const ret = await this.encryptedCollection.decryptContent(this.cryptoManager);
    switch (outputFormat) {
      case OutputFormat.Uint8Array:
        return ret;
      case OutputFormat.String:
        return sodium.to_string(ret);
      default:
        throw new Error("Bad output format");
    }
  }

  public get uid() {
    return this.encryptedCollection.uid;
  }

  public get etag() {
    return this.encryptedCollection.etag;
  }

  public get stoken() {
    return this.encryptedCollection.stoken;
  }
}

export class CollectionItem {
  private readonly cryptoManager: CollectionItemCryptoManager;
  public readonly encryptedItem: EncryptedCollectionItem;

  public constructor(cryptoManager: CollectionItemCryptoManager, encryptedItem: EncryptedCollectionItem) {
    this.cryptoManager = cryptoManager;
    this.encryptedItem = encryptedItem;
  }

  public async verify() {
    return this.encryptedItem.verify(this.cryptoManager);
  }

  public async setMeta(meta: CollectionItemMetadata): Promise<void> {
    await this.encryptedItem.setMeta(this.cryptoManager, meta);
  }

  public async getMeta(): Promise<CollectionItemMetadata> {
    return this.encryptedItem.decryptMeta(this.cryptoManager);
  }

  public async setContent(content: Uint8Array | string): Promise<void> {
    const uintcontent = (content instanceof Uint8Array) ? content : sodium.from_string(content);
    await this.encryptedItem.setContent(this.cryptoManager, uintcontent);
  }

  public async getContent(outputFormat?: OutputFormat.Uint8Array): Promise<Uint8Array>;
  public async getContent(outputFormat?: OutputFormat.String): Promise<string>;
  public async getContent(outputFormat: OutputFormat = OutputFormat.Uint8Array): Promise<any> {
    const ret = await this.encryptedItem.decryptContent(this.cryptoManager);
    switch (outputFormat) {
      case OutputFormat.Uint8Array:
        return ret;
      case OutputFormat.String:
        return sodium.to_string(ret);
      default:
        throw new Error("Bad output format");
    }
  }

  public get uid() {
    return this.encryptedItem.uid;
  }

  public get etag() {
    return this.encryptedItem.etag;
  }

  public _clone() {
    return new CollectionItem(this.cryptoManager, EncryptedCollectionItem.deserialize(this.encryptedItem.serialize()));
  }
}
