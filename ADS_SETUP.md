# Ads setup

Default ad provider is AdsGram. The existing Monetag code is kept intact, but is not loaded when AdsGram is selected.

Set the environment variables in your hosting panel or `.env`:

```dotenv
AD_PROVIDER=adsgram
ADSGRAM_BLOCK_ID=57682
MONETAG_ZONE_ID=11502469
```

To switch back to Monetag later, set `AD_PROVIDER=monetag` and restart/redeploy. To turn off all ads, use `AD_PROVIDER=none` (rewarded ad features will not be usable). Change `ADSGRAM_BLOCK_ID` and restart/redeploy to change the AdsGram block. Existing ads-free subscription exemptions still apply.

AdsGram is wired to Spin, Watch Ad, and the periodic lecture-click ad placement. Rewarded actions only succeed when the SDK's `show()` promise resolves; failure or skip rejects. Existing backend reward cooldowns/checks are unchanged. AdsGram has no equivalent of Monetag's automated in-app stream, so the latter runs only in Monetag mode. Monetag-specific adblock checks are also disabled in AdsGram mode.

**Note:** AdsGram's `57682` must be a *Reward* block approved for this Telegram Mini App. The block must pass platform moderation and have available inventory; these cannot be verified by static code tests.

Documentation: https://docs.adsgram.ai/publisher/reward-interstitial-integration
