function convertSQL(input, is_subquery = false){
    input = input.toLowerCase().trim();
    input = input.replace(/;/g,"");
    input = input.replace(/,/g,", ");
    input = input.replace(/in\(/g,"in (");
    input = input.replace(/(\r\n|\n|\r)/gm, " ");
    input = input.replace(/\s+/gm, " ");

    if(is_subquery){ //if subquery remove trailing parentheses
        input = input.trim().replace(/^\(/g,"").replace(/\)$/g,"")
    }

    //get all case when as selectRaw
    var get_all = getAll(/case when (.+?) end (.+?)`(.+?)`/g, input)
    select_raws = get_all.matches
    input = get_all.input

    //get all subqueries and functions on select
    get_all = getAll(/(([a-z]|[a-z]_[a-z])+?| )\(.+?\)( | as)`.+?`/g, input, "select_subquery_function")
    input = get_all.input
    select_subqueries_functions = get_all.result

    //get all subqueries and grouped clauses on where
    get_all = getAll(/( *?\(.+?\))/g, input, "where_subquery_group")
    input = get_all.input
    where_subqueries_groups = get_all.result


    //clean whitespaces again
    input = input.replace(/\s+/gm, " ");

    //divide the sql statement using the wildcards
    var parts = input.split(/select | from | where | order by | limit /)

    var composition = {
        select : parts[1] ?? "",
        from : parts[2] ?? "",
        where : parts[3] ?? "",
        order_by : parts[4] ?? "",
        limit : parts[5] ?? ""
    }

    return compose(composition, select_raws, select_subqueries_functions, where_subqueries_groups, is_subquery)

    //test sql statement
    return input
}

function compose(composition, select_raws, select_subqueries_functions, where_subqueries_groups, is_subquery){
    var w = where_subqueries_groups
    var composed = [] //init

    var table = ""
    var delimiter = "\n"

    //get tables
    var tables = composition.from.split(/left join|right join|inner join|full join|cross join|join/);

    //get primary table
    table = tables[0].trim()
    if(is_subquery){ //if subquery conditions
        composed.push(`$query->from("${table}")`)
        delimiter = "\n\t"
    }else{
        composed.push(`DB::table("${table}")`)
    }

    //table joins
    var x = 0
    for(table_clause of tables){
        if(x == 0){
            x++;
            continue
        }
        composed.push(join(table_clause, composition.from.trim().match(/left join|right join|inner join|full join|cross join|join/g), x - 1, w))
        x++
    }
    

    //select normal columns
    var columns = composition.select.split(",").filter((x)=>(!x.trim().includes("select_subquery_function")&&x.trim()!="")).map(function(x){ return `"${x.trim()}"`}).join(", ")
    if(columns != `"*"`){
        composed.push(`->select(${changeGroups(columns, w)})`)
    }

    for(column of select_raws){
        column = column.trim()
        composed.push(`->addSelect(DB::raw("${column}"))`)
    }

    //get selected columns
    for(column of composition.select.split(",")){
        column = column.trim()
        if(column.includes("select_subquery_function")){
            value = select_subqueries_functions[` ${column}`] ?? ""
            value = value.trim()
            if(value != ""){
                if(/^\(.+?/g.test(value)){ //subqueries
                    alias = getAlias(value)
                    if(alias != ""){
                        composed.push(`->addSelect(['${alias}' => ${getSubquery(value)}])`)    
                    }    
                }else{ //functions
                    composed.push(`->addSelect(DB::raw("${value}"))`)
                }
            }
        }
    }

    //only do where if there's a where clause
    if(composition.where.trim() != ""){
        //get where
        first_condition = composition.where.split(/and|or/)[0].trim()
        if(first_condition != ""){
            composed.push(where(first_condition, w))
        }

        //get all operators AND/OR
        get_all = getAll(/ and | or /g, composition.where.replace(first_condition, "").trim())
        operators = get_all.matches

        //get all conditions
        conditions = composition.where.trim().split(/ and | or /g).map(function(x){return x.trim()})

        x = 0
        for(condition of conditions){
            if(x == 0){
                x++;
                continue
            }
            pre = (operators[x-1] ?? "") == "or" ? "orWhere" : "where"
            try{
                composed.push(where(condition, w, pre))
            }catch(e){
                console.log(x, conditions)
            }
            x++;
        }
    }

    //only do order by if there's a order by clause
    if(composition.order_by.trim() != ""){
        composed.push(`->orderBy(${composition.order_by.split(" ").map(function(x){ return `"${x}"`}).join(",")})`)
    }

    //only do limit if there's a limit clause
    if(composition.limit.trim() != ""){
        limit = composition.limit.trim()
        if(/offset|,/g.test(limit)){
            parts = limit.split(/offset|,/g)
            if(/offset/g.test(limit)){
                if(typeof parts[1] !== "undefined"){
                    composed.push(`->offset(${(parts[1] ?? "").trim()})`)
                }
                composed.push(`->limit(${parts[0].trim()})`)
            }else{
                composed.push(`->offset(${parts[0].trim()})`)
                if(typeof parts[1] !== "undefined"){
                    composed.push(`->limit(${(parts[1] ?? "").trim()})`)
                }
            }
        }else{
            composed.push(`->limit(${limit})`)
        }
    }

    if(is_subquery){
        return composed.join(delimiter)+";"
    }
    return composed.join(delimiter)
}

function changeGroups(string, w){
    var regex = /where_subquery_group_(\d+)/g
    if(regex.test(string)){
        matches = string.match(regex)
        if(Array.isArray(matches)){
            for(match of matches){
                string = string.replace(match, w[` ${match}`].trim()).trim()
            }
        }
        return `DB::raw(${string})`
    }
    return string
}

function join(table_clause, joins, x, w){
    if(!Array.isArray(joins)){
        joins = []
    }

    joins = joins.map(function(x){return x.trim()})

    if(typeof joins[x] !== 'undefined'){
        var prepend = joins[x].replace(/^(.)|\s+(.)/g, function ($1) {
            return $1.toUpperCase()
          })
        prepend = prepend.replace(/ /g, "")
        prepend = lowerCaseFirstLetter(prepend)
        var alias = table_clause.split(/on/g)[0].trim()
        if(prepend == "crossJoin"){
            regex = /where_subquery_group_(\d+)/g
            if(regex.test(table_clause)){
                matches = table_clause.match(regex)
                if(Array.isArray(matches)){
                    for(match of matches){
                        table_clause = table_clause.replace(match, w[` ${match}`].trim()).trim()
                    }
                }
            }
            return `->${prepend}(DB::raw("${table_clause}"))`
        }
        return `->${prepend}("${alias}", function($join){\n\t${joinCondition(table_clause.replace(alias, "").trim(), w)}\n})`
    }
    return "";
}

function joinCondition(condition_string, w){
    var regex = / and | or /g
    var joins = []
    condition_string = condition_string.replace(/on/g, "")

    var first_condition = condition_string.split(regex)[0].trim()
    if(first_condition != ""){
        joins.push(conditionOn(first_condition, w))
    }

    //get all operators AND/OR
    var get_all = getAll(/ and | or /g, condition_string.replace(first_condition, "").trim())
    operators = get_all.matches

    //get all conditions
    var conditions = condition_string.trim().split(/ and | or /g).map(function(x){return x.trim()})

    x = 0
    for(condition of conditions){
        if(x == 0){
            x++;
            continue
        }
        pre = (operators[x-1] ?? "") == "or" ? "orOn" : "on"
        try{
            joins.push(conditionOn(condition, w, pre))
        }catch(e){
            console.log(x, conditions)
        }
        x++;
    }
    return "$join"+joins.join("\n\t")+";"
}

function conditionOn(value, w, pre = "on"){
    var parts = value.split(" ")
    if((typeof parts[1] == 'undefined' && typeof w[` ${parts[0].trim()}`] !== 'undefined')){
        return `->${pre}(DB::raw(${w[` ${parts[0]}`].trim()}))`
    }
    last = `"${parts[2].trim()}"`
    if((parts[2].trim().startsWith(`'`) && parts[2].trim().endsWith(`'`))||(parts[2].trim().startsWith(`"`) && parts[2].trim().endsWith(`"`))){
        last = parts[2].trim()
    }
    if(value.includes("where_subquery_group")){
        condition = w[` ${parts[2].trim()}`].trim()
        if(/^(\(select|\( select)/g.test(condition)){
            last = getSubquery(condition)
        }else{
            last = "["+w[` ${parts[2]}`].trim().replace(/^\(/g,"").replace(/\)$/g,"")+"]"
        }
    }
    if(parts[1].trim() == "in"){
        return `->${pre}In("${parts[0]}", ${last})`
    }
    if(parts[1].trim() == "is" || parts[1].trim() == "between"){
        return `->${pre}(DB::raw("${value}"))`
    }
    return `->${pre}("${parts[0]}", "${parts[1]}", ${last})`
}

function lowerCaseFirstLetter(string) {
    return string.charAt(0).toLowerCase() + string.slice(1);
}


function where(value, w, pre = "where"){
    var parts = value.split(" ")
    var string = value
    var subject = string.split(" ")[0] ?? ""
    var operator = string.split(" ")[1] ?? ""
    var subject_operator = `"${subject}", "${operator}"`;
    if(typeof parts[1] == 'undefined' && typeof w[` ${parts[0].trim()}`] !== 'undefined'){
        return `->${pre}(DB::raw(${w[` ${parts[0]}`].trim()}))`
    }
    last = `"${parts[2]}"`
    if(value.includes("where_subquery_group")){
        condition = w[` ${parts[2].trim()}`].trim()
        if(/^(\(select|\( select)/g.test(condition)){
            last = getSubquery(condition)
        }else{
            last = "["+w[` ${parts[2]}`].trim().replace(/^\(/g,"").replace(/\)$/g,"")+"]"
        }
    }
    if(parts[1].trim() == "in"){
        return `->${pre}In("${parts[0]}", ${last})`
    }else if(/is null/g.test(value)){
        return `->${pre}Null("${parts[0]}")`
    }else if(/is not null/g.test(value)){
        return `->${pre}NotNull("${parts[0]}")`
    }
    console.log(value, parts, `->${pre}("${subject}", "${operator}", ${last})`)
    return `->${pre}(${subject_operator}, ${last})`
    
}

function getSubquery(value){
    value = value.replace(/`(.+?)`$/g, "")
    return `function($query){\n\t${convertSQL(value, true)}\n}`
}

function getAlias(value){
    var regex = /`.+?`$/g
    value = value.trim()
    var matches = value.match(regex)

    if(!Array.isArray(matches)){
        matches = []
    }

    var alias = matches[0] ?? ""
    return alias.replace(/`/g, "").trim()
}

function getAll(regex, input, alias = ""){
    var result = {}
    var matches = input.match(regex)

    if(!Array.isArray(matches)){
        matches = []
    }

    var x = 1
    for(match of matches){
        replace = ` ${alias}_${x}`
        if(alias == ""){
            replace = ""
        }
        input = input.replace(match, replace)
        result[replace] = match;
        x++
    }
    return {
        result : result,
        input : input,
        matches : matches
    }
}

