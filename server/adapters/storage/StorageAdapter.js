class StorageAdapter {
  /**
   * ファイルをアップロードする
   * @param {Object} params
   * @param {Buffer|ReadableStream} params.file - ファイル本体
   * @param {string} params.fileName - 保存時のファイル名
   * @param {string} params.contentType - MIMEタイプ
   * @param {string} [params.folder] - フォルダ
   * @returns {Promise<{id: string, url: string}>} - 保存されたファイルのIDと公開URL
   */
  async upload(params) {
    throw new Error('upload() must be implemented');
  }

  async createUploadTarget(params) {
    throw new Error('createUploadTarget() must be implemented');
  }

  async uploadToId(params) {
    throw new Error('uploadToId() must be implemented');
  }

  /**
   * ファイルを削除する
   * @param {string} fileId - upload時に返したID
   * @returns {Promise<void>}
   */
  async delete(fileId) {
    throw new Error('delete() must be implemented');
  }

  /**
   * 公開URLを取得する
   * @param {string} fileId
   * @returns {Promise<string>}
   */
  async getPublicUrl(fileId) {
    throw new Error('getPublicUrl() must be implemented');
  }

  /**
   * 保存済みファイルを読み取る。
   * @param {string} fileId
   * @returns {Promise<{buffer: Buffer, contentType: string|null}>}
   */
  async read(fileId) {
    throw new Error('read() must be implemented');
  }

  /**
   * 保存済みファイルを別のキーへ複製する。ソースは削除しない。
   * @param {string} sourceFileId
   * @param {string} destinationFileId
   * @returns {Promise<{id: string, key: string, url: string|null}>}
   */
  async copy(sourceFileId, destinationFileId) {
    throw new Error('copy() must be implemented');
  }

  /**
   * 複数ファイルを一括削除
   * @param {string[]} fileIds
   * @returns {Promise<void>}
   */
  async deleteMany(fileIds) {
    throw new Error('deleteMany() must be implemented');
  }

  /**
   * 指定フォルダ配下の保存済み容量を返す。
   * @param {string} folder
   * @returns {Promise<number>} バイト数
   */
  async getUsage(folder) {
    throw new Error('getUsage() must be implemented');
  }

  /**
   * 指定フォルダ配下のファイルを一覧する。
   * @param {string} folder
   * @param {{limit?: number}} [options]
   * @returns {Promise<Array<{id: string, name: string, size: number, updatedAt: string|null}>>}
   */
  async listFiles(folder, options = {}) {
    throw new Error('listFiles() must be implemented');
  }
}

module.exports = StorageAdapter;
