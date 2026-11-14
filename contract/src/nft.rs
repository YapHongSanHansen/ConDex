//! The thesis NFT: one token per thesis version (NEP-171), with NEP-177 metadata.

use near_sdk::{env, near, require, serde_json, AccountId, NearToken};

use crate::events::{Nep171Event, NftMintLog};
use crate::types::{
    ExpirySetBy, NFTContractMetadata, SplitEntry, Thesis, ThesisExtra, TimestampMs, Token, TokenId,
    TokenMetadata, FULL_SHARE,
};
use crate::{assert_hash, assert_id, Contract, ContractExt};

const NOT_TRANSFERABLE: &str = "A thesis NFT stays with its creator and cannot be transferred";

#[near]
impl Contract {
    /// Mints the token of one thesis version. Only the operator can.
    ///
    /// `fee` is the usage fee per filled trade. `content_hash` is the fingerprint of the conditions, the
    /// expiry and the approved conversation. `issued_at` and `expires_at` are Unix milliseconds.
    /// The whole fee goes to `payout_account`: the revenue split has that one entry, at 100%.
    #[allow(clippy::too_many_arguments)]
    pub fn mint_thesis(
        &mut self,
        token_id: TokenId,
        owner: AccountId,
        payout_account: AccountId,
        fee: NearToken,
        content_hash: String,
        issued_at: TimestampMs,
        expires_at: TimestampMs,
        expiry_set_by: ExpirySetBy,
    ) {
        self.assert_operator();
        assert_id(&token_id, "token_id");
        assert_hash(&content_hash, "content_hash");
        require!(expires_at > issued_at, "expires_at must be after issued_at");
        require!(
            !self.theses.contains_key(&token_id),
            format!("Token {token_id} is already minted")
        );

        self.theses.insert(
            token_id.clone(),
            Thesis {
                owner_id: owner.clone(),
                payout_account: payout_account.clone(),
                revenue_split: vec![SplitEntry {
                    account_id: payout_account,
                    basis_points: FULL_SHARE,
                }],
                fee: fee.as_yoctonear(),
                content_hash,
                issued_at,
                expires_at,
                expiry_set_by,
                proof_count: 0,
            },
        );
        Nep171Event::NftMint(vec![NftMintLog {
            owner_id: owner,
            token_ids: vec![token_id],
        }])
        .emit();
    }

    /// The token and its metadata, or nothing when the token does not exist.
    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        let thesis = self.theses.get(&token_id)?;
        let extra = ThesisExtra {
            content_hash: thesis.content_hash.clone(),
            fee: NearToken::from_yoctonear(thesis.fee),
            payout_account: thesis.payout_account.clone(),
            revenue_split: thesis.revenue_split.clone(),
            expiry_set_by: thesis.expiry_set_by,
            proof_count: thesis.proof_count,
            evaluation: crate::evaluation::evaluation_of(&token_id),
        };
        Some(Token {
            owner_id: thesis.owner_id.clone(),
            metadata: TokenMetadata {
                title: Some(format!("ConDex thesis {token_id}")),
                description: Some(
                    "Proof of thesis: one version of one trading thesis published on ConDex. \
                     Only the fingerprint of its content is on chain."
                        .to_string(),
                ),
                media: None,
                media_hash: None,
                copies: Some(1),
                issued_at: Some(thesis.issued_at),
                expires_at: Some(thesis.expires_at),
                starts_at: None,
                updated_at: None,
                extra: Some(
                    serde_json::to_string(&extra).unwrap_or_else(|_| {
                        env::panic_str("Cannot write the token's extra fields")
                    }),
                ),
                reference: None,
                reference_hash: None,
            },
            token_id,
        })
    }

    /// The name and symbol of the collection.
    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: "nft-1.0.0".to_string(),
            name: "ConDex Thesis".to_string(),
            symbol: "CONDEX".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    /// Part of NEP-171. Always fails: the token stays with its creator.
    #[payable]
    #[allow(unused_variables)]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        env::panic_str(NOT_TRANSFERABLE)
    }

    /// Part of NEP-171. Always fails: the token stays with its creator.
    #[payable]
    #[allow(unused_variables)]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> bool {
        env::panic_str(NOT_TRANSFERABLE)
    }
}
