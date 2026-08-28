# Check Goal Completion

You are determining whether the user's Goal has been fully accomplished by
the completed steps in this TapHound generation session.

## Inputs

- **Goal**: the user's natural-language test scenario.
- **Completed steps**: the list of steps that have succeeded so far, each
  with its action, locator, and result.
- **Base Flow**: optional reusable navigation prefix and its exit Activity.

## Your Task

Break the Goal into its implied sub-tasks, then check each against the
completed steps.

## How to Decide

1. **Decompose the Goal** into ordered sub-tasks. For example:
   - Goal: "test search: click open search, input hello world, submit,
     verify logcat"
   - Sub-tasks:
     1. Click the search button to open the search screen.
     2. Focus the search input field.
     3. Type "hello world" into the search input.
     4. Click submit.
     5. Verify the logcat event for the submitted query.

2. **Map completed steps to sub-tasks**. A sub-task is satisfied if a
   completed step directly accomplishes it:
   - A `click` step with the right locator satisfies a "click X" sub-task.
   - An `inputText` step with the right text satisfies a "type X" sub-task.
   - A step with an `expect` that passed satisfies a "verify X" sub-task.
   - A bound Base Flow may satisfy navigation to its exit Activity, but it
     never satisfies business actions or assertions that belong to the Goal.

3. **Return the result**:
   - If every sub-task has a corresponding completed step:
     ```json
     { "complete": true }
     ```
   - If some sub-tasks remain:
     ```json
     { "complete": false, "remaining": "Brief description of what's left" }
     ```

## Rules

- Be conservative: only mark complete if you are confident every part of the
  Goal has been addressed.
- Do not count a step as completing a sub-task if the step failed or was
  rejected by Core.
- If the Goal is ambiguous, map it to the most reasonable interpretation and
  note any assumptions.
