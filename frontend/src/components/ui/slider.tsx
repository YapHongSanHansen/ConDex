"use client";

import * as S from "@radix-ui/react-slider";

export function Slider({ label, ...p }: React.ComponentPropsWithoutRef<typeof S.Root> & { label: string }) {
  return (
    <S.Root className="relative flex h-5 w-full touch-none select-none items-center" {...p}>
      <S.Track className="relative h-1 grow rounded-full bg-border">
        <S.Range className="absolute h-full rounded-full bg-accent" />
      </S.Track>
      <S.Thumb aria-label={label} className="block h-4 w-4 cursor-pointer rounded-full border border-accent bg-background" />
    </S.Root>
  );
}
