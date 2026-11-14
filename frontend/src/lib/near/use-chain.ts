"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Order } from "@/lib/api/wire";
import { useWallet } from "./connector";
import { approveFeeOnContract, depositToContract, subscribeOnContract } from "./contract";

/** Which ledger the backend runs on. On the mock ledger the backend moves test NEAR itself; on NEAR the trader signs. */
export function useLedger() {
  return useQuery({ queryKey: ["ledger"], queryFn: () => api.trading.ledger(), staleTime: 5 * 60_000 });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The wallet calls a trader makes on NEAR. Each one signs a transaction, then waits for the backend to see its effect. */
export function useChainActions() {
  const { getWallet } = useWallet();
  const qc = useQueryClient();
  const ledger = useLedger();
  const contractId = ledger.data?.contractId ?? "";

  const refresh = (...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  return {
    onChain: ledger.data?.kind === "near",
    ready: !ledger.isLoading,

    async deposit(amountNear: string) {
      await depositToContract(await getWallet(), contractId, amountNear);
      refresh("balances");
    },

    /** Pays the subscription, then waits for the backend to read it from the contract. */
    async subscribe(priceYocto: string, account: string) {
      await subscribeOnContract(await getWallet(), contractId, priceYocto);
      for (let i = 0; i < 12; i++) {
        const s = await api.trading.subscription();
        if (s.active) break;
        await wait(1500);
      }
      refresh("subscription", "balances", "read");
      void account;
    },

    /** Signs `reserve_fee` for an order that is awaiting approval, then has the backend confirm it on chain and submit the order. */
    async approve(order: Order): Promise<Order> {
      if (!order.approval) return order;
      await approveFeeOnContract(await getWallet(), order.approval);
      let last: unknown;
      // The transaction may take a moment to be final: the backend says approval_missing until it is.
      for (let i = 0; i < 8; i++) {
        try {
          const confirmed = await api.trading.confirmApproval(order.id);
          refresh("orders", "order", "balances", "proof");
          toast.success("Fee approved. The order is on its way to the venue.");
          return confirmed;
        } catch (e) {
          last = e;
          await wait(1500);
        }
      }
      throw last;
    },
  };
}
