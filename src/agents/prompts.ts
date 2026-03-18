export const QUESTION_TYPES_XML = `<question-types>
<type name="pick_one">
Single choice. config: { question, options: [{id, label, description?}], recommended?, context? }
</type>

<type name="pick_many">
Multiple choice. config: { question, options: [{id, label, description?}], recommended?: string[], min?, max?, context? }
</type>

<type name="confirm">
Yes/no. config: { question, context?, yesLabel?, noLabel?, allowCancel? }
</type>

<type name="ask_text">
Free text. config: { question, placeholder?, context?, multiline? }
</type>

<type name="slider">
Numeric range. config: { question, min, max, step?, defaultValue?, context? }
</type>

<type name="rank">
Order items. config: { question, options: [{id, label, description?}], context? }
</type>

<type name="rate">
Rate items (stars). config: { question, options: [{id, label, description?}], min?, max?, context? }
</type>

<type name="thumbs">
Thumbs up/down. config: { question, context? }
</type>

<type name="show_options">
Options with pros/cons. config: { question, options: [{id, label, description?, pros?: string[], cons?: string[]}], recommended?, allowFeedback?, context? }
</type>

<type name="show_diff">
Code diff review. config: { question, before, after, filePath?, language? }
</type>

<type name="ask_code">
Code input. config: { question, language?, placeholder?, context? }
</type>

<type name="ask_image">
Image upload. config: { question, multiple?, maxImages?, context? }
</type>

<type name="ask_file">
File upload. config: { question, multiple?, maxFiles?, accept?: string[], context? }
</type>

<type name="emoji_react">
Emoji selection. config: { question, emojis?: string[], context? }
</type>

<type name="review_section">
Section review. config: { question, content, context? }
</type>

<type name="show_plan">
Plan review. config: { question, sections: [{id, title, content}] }
</type>
</question-types>`;
