import React from "react";
import { Box, Text } from "ink";
import { animeTheme } from "../theme";

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
      <Text color={animeTheme.mint} bold>
        ❯{" "}
      </Text>
      <Text>{display}</Text>
    </Box>
  );
}
