import React from "react";
import { Box, Text } from "ink";
import { animeTheme, formatPromptGlyph } from "../theme/index";

export function InputPrompt({
  display,
  isBusy,
}: {
  display: string;
  isBusy: boolean;
}): React.JSX.Element {
  if (isBusy) return <Box />;
  return (
    <Box marginTop={1}>
      <Text color={animeTheme.mint} bold>{formatPromptGlyph()}</Text>
      <Text>{display}</Text>
    </Box>
  );
}
