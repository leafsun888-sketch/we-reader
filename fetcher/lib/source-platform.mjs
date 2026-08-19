export const sourcePlatform = (source) => source?.platform || 'wechat';
export const isWechatSource = (source) => sourcePlatform(source) === 'wechat';
