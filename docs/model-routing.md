# Model Routing

Auto (`kimchi-dev/auto`) is a virtual model that asks the Kimchi router to choose a concrete model for each session.

Auto is useful when you want Kimchi to choose between the models available to you without changing models manually for every new task.

## Enable model routing

Start Kimchi with experimental features enabled, then select Auto:

```sh
kimchi --enable-experimental-features --model auto
```

You can also start Kimchi with `--enable-experimental-features` and select **Auto (Kimchi Router)** from `/model`.

The experimental flag controls whether Auto is offered as a new choice. It does not disable Auto if you already selected it:

- a saved Auto default continues to work without the flag;
- a session saved with Auto can be resumed without the flag;
- explicitly selecting Auto for a new session still requires the flag.

The router uses your existing Kimchi API key. There is no separate router authentication to configure.

## How Auto chooses a model

Auto waits until you send the first prompt that needs a model response. It then:

1. sends the prompt text to the Kimchi router;
2. receives a ranked list of candidate models;
3. selects the first eligible candidate;
4. uses that concrete model for the rest of the session.

The router identifies its preferred model and supplies scores for the other candidates. Kimchi considers the preferred model first, followed by the remaining candidates from highest to lowest score.

A candidate is eligible only when it:

- is an available concrete model in the `kimchi-dev` model catalog;
- belongs to the active model scope, if you used `--models` to limit the session;
- supports the input required by the first prompt.

For example, suppose the router ranks models A, B, and C. If A is outside your `--models` scope and the prompt contains an image that B cannot read, Kimchi selects C if C is scoped, available, and supports vision.

Skipping an ineligible candidate from the ranked response is part of the routing decision, not a fallback after inference.

The interface continues to show Auto as your selected model before and after routing:

```text
auto
```

After routing, the concrete model's capabilities and limits apply without revealing its identity, including vision support, context window, reasoning support, and provider availability.

Before routing, Auto exposes reasoning levels as a session preference. After routing, the available controls follow the selected model's supported levels. If that model does not support reasoning, Kimchi changes the session level to `off` and only offers `off` in the settings UI.

## Failures and retries

Routing can fail because the router cannot be reached, times out, rejects the request, or returns an invalid response. It also fails when routing is cancelled, prompt redaction fails, or no ranked candidate meets the prompt's requirements.

When routing fails, Auto stops the current prompt before inference and the model remains unresolved. Kimchi does not automatically replay the prompt or send it to a fallback model. If you submit another prompt while Auto is still selected, Kimchi tries the router again. You can instead select a concrete model with `/model`.

After a model is selected, there is no automatic fallback if that model is rate limited, returns an inference error, or becomes unavailable. Select another model with `/model` if you want to continue with a different model.

## Session lifecycle

The routing decision belongs to the session:

- A new Auto session remains unresolved until you send the first prompt that needs a model response.
- A successful recommendation is saved with the session. Resuming it restores the same concrete model without contacting the router again.
- Routing attempts and failures are not saved. If the process exits during routing, the next prompt after resuming can try again.
- Switching away from Auto and back to it reuses a successful recommendation. If no model was selected, Auto remains unresolved.
- If the saved concrete model is no longer available, Auto does not reroute. Select another model with `/model` to continue.
- A concrete model provided on the command line when resuming overrides Auto.

Each local subagent that inherits Auto has its own session and chooses a model independently. A subagent started with an explicit concrete model does not use the router. Remote subagent routing is not currently supported.

## Prompts, redaction, and images

The router receives the full text of the prompt that triggers routing. When the effective prompt contains images, Kimchi appends `[Routing metadata: the prompt contains images.]` to the router copy. Kimchi does not apply a client-side token limit, and it does not shorten or otherwise change the prompt sent to the selected model.

When PII redaction is enabled, the router copy receives the same PII and secret redaction policy as normal provider traffic. If that copy cannot be redacted safely, routing stops.

The router never receives image bytes. Kimchi still uses the presence of an image when checking candidate capabilities:

- for an initial prompt with text and images, candidates without vision support are skipped;
- an image-only initial prompt routes using the image metadata marker;
- after Auto resolves to a vision-capable model, later image prompts continue normally;
- after Auto resolves to a text-only model, a later image prompt is blocked without rerouting.

If a later image is blocked, select a vision-capable model with `/model`, or use `/strip-images` when removing existing images is appropriate.
